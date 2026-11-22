import "server-only";
import { recorderDatabase } from "./recorder-server";
import { googleRedirectUri } from "./google-redirect";
import { googleToken } from "./google-server";
import { decryptSecret } from "./google-crypto";
import { MailError } from "./gmail";

export async function gmailConfig(tenant:string) {
  const clientId=process.env.GOOGLE_CLIENT_ID;
  const clientSecret=process.env.GOOGLE_CLIENT_SECRET;
  const configured=await recorderDatabase(tenant).from("tenant_google_settings").select("owner_email").maybeSingle();
  if(configured.error) throw new MailError("gmail_configuration_unavailable","retry");
  const owner=configured.data?.owner_email || process.env.GOOGLE_SENDER_EMAIL;
  if(!clientId || !clientSecret || !owner || !process.env.TOKEN_ENCRYPTION_KEY) throw new MailError("gmail_configuration_missing","failed");
  return {clientId,clientSecret,owner,redirect:googleRedirectUri()};
}
export async function connectedGmail(tenant:string) {
  const db=recorderDatabase(tenant);
  const result=await db.from("gmail_integrations").select("*").maybeSingle();
  if(result.error) throw new MailError("gmail_connection_unavailable","retry");
  const integration=result.data;
  if(!integration) throw new MailError("gmail_not_connected","failed");
  const config=await gmailConfig(tenant);
  if(integration.owner_email.toLowerCase()!==config.owner.toLowerCase()) throw new MailError("gmail_reconnect_required","failed");
  const tokens=await googleToken({grant_type:"refresh_token",refresh_token:decryptSecret(integration.refresh_token_encrypted)},config);
  return {integration:{...integration,gmail_authorized_at:integration.connected_at},accessToken:tokens.access_token as string};
}
