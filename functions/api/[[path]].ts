// Cloudflare Pages Function for every /api/* request on the food index's site. The logic is in server/.
import { handle, type Env } from "../../server/handler";

export const onRequest = (context: { request: Request; env: Env }): Promise<Response> => handle(context.request, context.env);
