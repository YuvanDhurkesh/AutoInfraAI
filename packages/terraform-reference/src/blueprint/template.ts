/**
 * A deliberately tiny template language for the blueprint files, so they
 * stay readable as the Terraform/YAML/shell they produce:
 *
 *   {{NAME}}                          the value of NAME (must be defined)
 *   {{#if NAME}} ... {{else}} ... {{/if}}      truthy / falsy blocks (nestable)
 *   {{#unless NAME}} ... {{/unless}}
 *
 * Terraform's ${...} and shell's $VAR pass through untouched. An unknown
 * name is an error, never an empty string: a silent blank in generated
 * infrastructure is exactly the class of bug the blueprints exist to remove.
 */
export type TemplateContext = Record<string, string | number | boolean | undefined>;

const BLOCK = /\{\{#(if|unless) (\w+)\}\}((?:(?!\{\{#(?:if|unless) )[\s\S])*?)\{\{\/\1\}\}/;

export function renderTemplate(template: string, ctx: TemplateContext, name = "template"): string {
  // A block tag alone on its line takes the whole line with it, so blocks
  // leave no blank lines in YAML lists, HCL bodies or Caddyfiles.
  let out = template.replace(
    /^[ \t]*(\{\{(?:#(?:if|unless) \w+|\/(?:if|unless)|else)\}\})[ \t]*\n/gm,
    "$1",
  );
  // Innermost blocks first: a block body that contains no further opening tag.
  for (let match = out.match(BLOCK); match; match = out.match(BLOCK)) {
    const [whole, kind, key, body] = match;
    if (!(key! in ctx)) throw new Error(`${name}: unknown template flag "${key}"`);
    const [whenTrue, whenFalse = ""] = splitElse(body!);
    const truthy = Boolean(ctx[key!]);
    const chosen = (kind === "if" ? truthy : !truthy) ? whenTrue : whenFalse;
    out = out.slice(0, match.index) + chosen + out.slice(match.index! + whole!.length);
  }
  out = out.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = ctx[key];
    if (value === undefined || typeof value === "boolean")
      throw new Error(`${name}: no value for "{{${key}}}"`);
    return String(value);
  });
  if (/\{\{[#/]/.test(out)) throw new Error(`${name}: unbalanced template block`);
  // Blocks leave blank lines behind; collapse runs of them.
  return out.replace(/\n{3,}/g, "\n\n");
}

function splitElse(body: string): [string, string?] {
  const i = body.indexOf("{{else}}");
  return i < 0 ? [body] : [body.slice(0, i), body.slice(i + "{{else}}".length)];
}
