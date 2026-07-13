import type { DeployArgs } from "./commands/index";

export function deploymentName(args: DeployArgs): string {
  return `${args.service}-${args.env}`;
}
