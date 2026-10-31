/** What a deployment's env var may be called (a shell variable name). */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names the platform or the runtime sets itself (PORT, AWS_*, AUTOINFRA_*):
 * an owner's value would be ignored, or break the app.
 */
export const RESERVED_ENV_NAME =
  /^(AWS_|AUTOINFRA_|_HANDLER$|LAMBDA_|ORIGIN_SECRET$|PATH$|HOME$|PORT$)/;

/**
 * Names whose values are secrets: masked in the form, SecureString in SSM.
 * Database connection strings carry the password (mongodb+srv://user:pass@...).
 */
export const SECRET_ENV_NAME =
  /SECRET|KEY|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|^(MONGO\w*|DATABASE|DB|POSTGRES\w*|PG|MYSQL|REDIS)_?(URL|URI)$/i;
