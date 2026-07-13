export interface DeployArgs {
  env: string;
  service: string;
}

export function parseDeployArgs(env: string, service: string): DeployArgs {
  if (!env || !service) throw new Error("env and service are required");
  return { env, service };
}
