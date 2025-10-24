import { DiscordSDK, patchUrlMappings } from "@discord/embedded-app-sdk";
import { setCurrentProfile, setYourId } from './state.js';

patchUrlMappings([{prefix: '/ws', target: 'locofficial.fly.dev'}]);

export const discordSdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);

export async function setupDiscordSdk() {
  await discordSdk.ready();
  const { code } = await discordSdk.commands.authorize({
    client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify", "guilds"],
  });
  const response = await fetch("/api/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
  if (!response.ok) throw new Error('Token exchange failed');
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




