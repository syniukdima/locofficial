import { DiscordSDK, patchUrlMappings } from "@discord/embedded-app-sdk";
import { setCurrentProfile, setYourId } from './state.js';

patchUrlMappings([{prefix: '/ws', target: 'locofficial.fly.dev'}]);

export const discordSdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);

export async function setupDiscordSdk() {
  // Only wait until SDK is ready; no auth/token logic here
  await discordSdk.ready();
}

export async function authenticateAndLoadProfile() {
  const { code } = await discordSdk.commands.authorize({
    client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify", "guilds"],
  });
  const response = await fetch("/api/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
  if (!response.ok) {
    let message = 'Token exchange failed';
    try {
      const ct = response.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const body = await response.json();
        const details = JSON.stringify(body?.details || body?.error || body || {});
        if (/invalid_client|client_secret/i.test(details)) {
          message = 'Token exchange failed: invalid Discord client secret';
        }
      } else {
        const text = await response.text();
        if (/invalid_client|client_secret/i.test(text)) {
          message = 'Token exchange failed: invalid Discord client secret';
        }
      }
    } catch {}
    console.error(message, response.status);
    throw new Error(message);
  }
  const { access_token } = await response.json();
  const auth = await discordSdk.commands.authenticate({ access_token });
  const user = auth.user;
  let guildId = null;
  try {
    const channel = await discordSdk.commands.getChannel();
    guildId = (channel && channel.guild_id) || null;
  } catch {}
  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number(user.discriminator || 0) % 5}.png`;
  const profile = { id: user.id, username: user.username, discriminator: String(user.discriminator ?? '0'), avatarUrl, guildId };
  setCurrentProfile(profile);
  setYourId(user.id);
  return profile;
}




