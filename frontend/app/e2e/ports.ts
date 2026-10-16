export const frontendPort = process.env.MELTIPLY_FRONTEND_PORT?.trim() || "3000";
const frontendHost = process.env.MELTIPLY_FRONTEND_HOST?.trim() || "127.0.0.1";
export const frontendOrigin = `http://${frontendHost}:${frontendPort}`;
