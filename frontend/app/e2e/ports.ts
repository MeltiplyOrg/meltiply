function workflowPort(basePort: number, fallbackPort: number): string {
  const workflowId = process.env.CIRCLE_WORKFLOW_ID?.trim();
  if (!workflowId) return String(fallbackPort);

  let hash = 0;
  for (const character of workflowId) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  return String(basePort + (hash % 500));
}

export const frontendPort = process.env.MELTIPLY_FRONTEND_PORT?.trim() || workflowPort(3000, 3000);
const frontendHost = process.env.MELTIPLY_FRONTEND_HOST?.trim() || "127.0.0.1";
export const frontendOrigin = `http://${frontendHost}:${frontendPort}`;
