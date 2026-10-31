import adapter from "@sveltejs/adapter-static";

export default { kit: { adapter: adapter({ pages: "public", fallback: "200.html" }) } };
