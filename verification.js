/*
 * ============================================================================
 *  BlueRails Verification System
 * ============================================================================
 *
 *  This file powers Roblox account verification across two Discord servers:
 *  the main BlueRails community server and the BlueRails Development server.
 *
 *  It uses Roblox OAuth 2.0 (with PKCE), which means members prove they own
 *  their Roblox account by signing in on Roblox's own website. The bot never
 *  sees their password, and there are no codes to paste into a profile bio.
 *
 *  The full flow looks like this:
 *
 *    1. A member clicks the "Verification" button on a panel in Discord.
 *    2. The bot replies privately with a single-use "Sign in with Roblox" link.
 *    3. The member signs in on Roblox and approves the app.
 *    4. Roblox sends them to a small web relay (hosted on Vercel), which
 *       forwards the sign-in code to the bot's own HTTP server.
 *    5. The bot swaps that code for the member's Roblox ID and username
 *       (handled in utils/oauth.js and events/oauthServer.js).
 *    6. That server then calls completeVerification() in this file, which
 *       gives roles, sets the nickname, saves the link and logs it.
 *
 *  This file handles steps 1, 2 and 6.
 * ============================================================================
 */

// discord.js building blocks for events, buttons and message flags.
const { Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require("discord.js");

// All channel IDs, role IDs and settings live in one config file,
// so nothing is hard-coded in the logic below.
const config = require("../config");

// A tiny JSON file store. store.read("name") and store.write("name", data)
// load and save files in the bot's data folder.
const store = require("../utils/store");

// Shared UI helpers. ui.message() builds a Components V2 card (the light-blue
// panel style used everywhere), and ui.logEmbed() builds a compact log embed.
const ui = require("../utils/ui");

// Returns the BlueRails logo as an attachment, so panels can show it as a
// thumbnail without relying on an external image link that might expire.
const { logo } = require("../utils/branding");

// Creates the secure, single-use Roblox sign-in link (see utils/oauth.js).
const { createLink } = require("../utils/oauth");

// Looks up which Roblox groups a user is in, used for the Development
// server's "must be in our group" requirement.
const { getGroupMembership } = require("../utils/roblox");

/*
 * ----------------------------------------------------------------------------
 *  Server profiles
 * ----------------------------------------------------------------------------
 *  Each server that has verification gets a "profile". A profile holds
 *  everything that differs between servers: which channel the panel goes in,
 *  which roles to give and remove, where to log, the panel's wording, and
 *  (for the Development server) which Roblox group the member must be in.
 *
 *  Keeping these as data means the same code below works for both servers,
 *  and adding a third server would only mean adding a third profile.
 *
 *  The "...config.verification" lines copy that server's settings
 *  (channelId, verifiedRoleId, unverifiedRoleId, logChannelId and so on)
 *  straight into the profile.
 */
const PROFILES = {
    main: {
        key: "main",
        guildId: config.guilds.main,
        // Each server's button needs a unique ID so the bot knows which
        // server's profile to use when it is clicked.
        buttonId: "verify:start",
        // The name used to remember this panel's message ID in data/panels.json.
        panelKey: "verification",
        ...config.verification,
        title: "Welcome to BlueRails",
        body: "Welcome to BlueRails! In order to gain access to the rest of the server, you **MUST** verify your Roblox account with Discord. Please click the button below to verify now.",
        welcome: "Welcome to BlueRails!",
    },
    development: {
        key: "development",
        guildId: config.guilds.development,
        buttonId: "verify:start:development",
        panelKey: "developmentVerification",
        // This server's config also includes a groupId, which switches on the
        // Roblox group check in completeVerification() below.
        ...config.developmentVerification,
        title: "Welcome to BlueRails Development",
        body: "Welcome to BlueRails Development! In order to gain access to the rest of the server, you **MUST** verify your Roblox account with Discord. You must also be a member of the **BlueRails Development** Roblox group. Please click the button below to verify now.",
        welcome: "Welcome to BlueRails Development!",
    },
};

/*
 *  Finds the profile that belongs to a server, or null if the server
 *  has no verification set up.
 */
function profileForGuild(guildId) {
    return Object.values(PROFILES).find((profile) => profile.guildId === guildId) ?? null;
}

/*
 * ----------------------------------------------------------------------------
 *  Building the verification panel
 * ----------------------------------------------------------------------------
 *  Creates the message that sits in each verification channel: a light-blue
 *  card with the welcome text, the logo as a thumbnail, and a grey
 *  "Verification" button underneath.
 */
function buildPanel(profile) {
    // One grey (Secondary) button, tagged with this server's button ID.
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(profile.buttonId).setLabel("Verification").setStyle(ButtonStyle.Secondary)
    );

    // The logo is optional. If the image file is missing, the panel is still
    // sent, just without a thumbnail.
    const image = logo();

    const panel = ui.message({
        title: profile.title,
        body: profile.body,
        rows: [row],
        thumbnail: image?.url,
    });

    // "files" uploads the logo with the message. "attachments: []" clears any
    // old copy of the logo when an existing panel is edited, so it doesn't
    // build up duplicates every time the bot restarts.
    return { ...panel, files: image ? [image.file] : [], attachments: [] };
}

/*
 * ----------------------------------------------------------------------------
 *  Keeping one panel per channel
 * ----------------------------------------------------------------------------
 *  Runs every time the bot starts. Instead of posting a brand new panel on
 *  every restart (which would spam the channel), the bot remembers the
 *  message ID of the panel it posted last time and simply edits it.
 *
 *  It only posts a fresh panel if:
 *    - it has never posted one before, or
 *    - the old one was deleted, or
 *    - the old one is in an outdated format (not Components V2), in which
 *      case the old message is removed and replaced.
 */
async function ensurePanel(client, profile) {
    const channel = await client.channels.fetch(profile.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        console.error(`Verification channel for ${profile.key} not found. Check the channelId in config.js`);
        return;
    }

    const panels = store.read("panels");
    const panel = buildPanel(profile);

    if (panels[profile.panelKey]) {
        const existing = await channel.messages.fetch(panels[profile.panelKey]).catch(() => null);

        // The panel still exists and is in the modern format: update it in place.
        if (existing && existing.flags.has(MessageFlags.IsComponentsV2)) {
            await existing.edit(panel);
            return;
        }

        // The panel exists but is an old format that can't be converted,
        // so delete it and fall through to posting a new one.
        if (existing) await existing.delete().catch(() => {});
    }

    // Post a new panel and remember its message ID for next time.
    const message = await channel.send(panel);
    panels[profile.panelKey] = message.id;
    store.write("panels", panels);
    console.log(`Verification panel posted (${profile.key})`);
}

/*
 * ----------------------------------------------------------------------------
 *  Step 2: sending the sign-in link
 * ----------------------------------------------------------------------------
 *  Called when someone clicks "Verification". createLink() generates a
 *  secure Roblox sign-in URL and remembers who asked for it, which server
 *  they were in, and the button interaction (so the bot can update this
 *  same private message once they finish signing in).
 *
 *  The reply is ephemeral (only the clicker can see it), so links are never
 *  visible to anyone else.
 */
async function sendSignInLink(interaction) {
    const url = createLink({ userId: interaction.user.id, guildId: interaction.guild.id, interaction });

    // A Link-style button opens the URL in the member's browser.
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Sign in with Roblox").setStyle(ButtonStyle.Link).setURL(url)
    );

    await interaction.reply(
        ui.message(
            {
                title: "Roblox Verification",
                body: `Click the button below to sign in with Roblox and approve **BlueRails Verification**. Once you're done, you'll be verified automatically.\n\nThis link is only for you and expires in **${config.verification.linkMinutes} minutes**.`,
                rows: [row],
            },
            { ephemeral: true }
        )
    );
}

/*
 * ----------------------------------------------------------------------------
 *  Verification log
 * ----------------------------------------------------------------------------
 *  Posts a record of every successful verification to the staff log channel
 *  for that server: who verified, which Roblox account they linked, and when.
 *
 *  <t:UNIX:f> is Discord's timestamp format. It shows the time in each
 *  viewer's own time zone.
 */
async function sendLog(client, profile, user, robloxUser, verifiedAt) {
    const channel = await client.channels.fetch(profile.logChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        console.error(`Verification log channel for ${profile.key} not found. Check the logChannelId in config.js`);
        return;
    }

    const unix = Math.floor(verifiedAt.getTime() / 1000);

    const log = ui.logEmbed({
        title: "Member Verified",
        thumbnail: user.displayAvatarURL(),
        fields: [
            { name: "Discord", value: `${user}\n(\`${user.id}\`)` },
            {
                name: "Roblox",
                // Links straight to their Roblox profile for quick checking.
                value: `[${robloxUser.name}](https://www.roblox.com/users/${robloxUser.id}/profile)\n(\`${robloxUser.id}\`)`,
            },
            { name: "Verified", value: `<t:${unix}:f>` },
        ],
    });

    // A failed log shouldn't break verification, so errors are only printed.
    await channel.send(log).catch((error) => console.error("Could not send verification log:", error));
}

/*
 *  A small helper for failed verifications. It updates the member's private
 *  Discord message with the reason, and returns the same reason so the
 *  web page they land on after signing in can show it too.
 */
async function fail(interaction, title, message) {
    await interaction?.editReply(ui.message({ title, body: message })).catch(() => {});
    return { ok: false, title, message };
}

/*
 * ----------------------------------------------------------------------------
 *  Step 6: completing verification
 * ----------------------------------------------------------------------------
 *  Called by the OAuth server once Roblox has confirmed who the member is.
 *
 *  Inputs:
 *    - userId / guildId / interaction: who clicked, in which server, and their
 *      original button click (remembered by createLink earlier)
 *    - robloxUser: { id, name } confirmed by Roblox
 *
 *  It returns { ok, title, message }, which the web relay shows on the page
 *  the member sees after signing in.
 */
async function completeVerification(client, { userId, guildId, interaction }, robloxUser) {
    // Look up the server's profile, then the member inside that server.
    const profile = profileForGuild(guildId);
    const guild = profile ? await client.guilds.fetch(guildId).catch(() => null) : null;
    const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;

    // They might have left the server while signing in.
    if (!member) {
        return { ok: false, title: "Not In Server", message: "You need to be in the Discord server to verify." };
    }

    /*
     *  Group requirement (Development server only).
     *  If the profile has a groupId, the member's Roblox account must be in
     *  that Roblox group. If Roblox can't be reached, they're asked to try
     *  again rather than being wrongly refused.
     */
    if (profile.groupId) {
        let membership;
        try {
            membership = await getGroupMembership(robloxUser.id, profile.groupId);
        } catch (error) {
            console.error("Roblox group lookup failed during verification:", error);
            return fail(interaction, "Roblox Unavailable", "I couldn't reach Roblox to check your group. Please try again in a minute.");
        }
        if (!membership) {
            return fail(
                interaction,
                "Not In Group",
                `**${robloxUser.name}** isn't in the BlueRails Development Roblox group, so you can't be verified. Join it here, then click Verification again: ${profile.groupUrl}`
            );
        }
    }

    // Give the verified role. If this fails (usually because the bot's role is
    // below the verified role), stop here so nothing is half-done.
    try {
        await member.roles.add(profile.verifiedRoleId, `Verified as ${robloxUser.name} (${robloxUser.id})`);
    } catch (error) {
        console.error("Could not add verified role:", error);
        return fail(interaction, "Verification Failed", "I couldn't give you the verified role. Please contact a member of staff.");
    }

    // Remove the "unverified" role new members get when they join.
    if (member.roles.cache.has(profile.unverifiedRoleId)) {
        await member.roles
            .remove(profile.unverifiedRoleId, "Completed verification")
            .catch((error) => console.error("Could not remove unverified role:", error));
    }

    // Set their server nickname to their Roblox username. This can fail for
    // the server owner or anyone ranked above the bot, so it's allowed to
    // fail quietly and the member is told to ask staff instead.
    const nicknameSet = await member
        .setNickname(robloxUser.name, "Roblox verification")
        .then(() => true)
        .catch(() => false);

    /*
     *  Save the Discord to Roblox link. Other features rely on this:
     *  /getroles (group and game pass roles), /whois, the ticket system's
     *  reporter information, and the Moderator application review screen.
     */
    const verifiedAt = new Date();
    const verifications = store.read("verifications");
    verifications[userId] = {
        robloxId: robloxUser.id,
        robloxName: robloxUser.name,
        verifiedAt: verifiedAt.toISOString(),
        method: "oauth",
    };
    store.write("verifications", verifications);

    await sendLog(client, profile, member.user, robloxUser, verifiedAt);
    console.log(`${member.user.tag} verified as ${robloxUser.name} (${robloxUser.id}) in ${profile.key}`);

    // Update the private Discord message from step 2 so the member sees the
    // result in Discord as well as on the web page.
    const nicknameNote = nicknameSet ? "" : "\n\nI couldn't change your nickname, so please ask a member of staff to set it for you.";
    await interaction
        ?.editReply(
            ui.message({
                title: "Verified",
                body: `You've been verified as **${robloxUser.name}** (\`${robloxUser.id}\`). ${profile.welcome}${nicknameNote}`,
            })
        )
        .catch(() => {});

    // This is what the web page shows after they sign in.
    return {
        ok: true,
        title: "You're Verified",
        message: `You've been verified as ${robloxUser.name}. You can close this page and head back to Discord.`,
    };
}

/*
 * ----------------------------------------------------------------------------
 *  Wiring it all up
 * ----------------------------------------------------------------------------
 *  index.js calls this once at start-up and passes in the Discord client.
 */
function register(client) {
    // When the bot finishes logging in, make sure every server's panel exists.
    client.once(Events.ClientReady, async () => {
        for (const profile of Object.values(PROFILES)) {
            await ensurePanel(client, profile).catch((error) => console.error(`Failed to post ${profile.key} verification panel:`, error));
        }
    });

    // Listen for button clicks across the whole bot, and only react to
    // verification buttons clicked in the server they belong to.
    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isButton()) return;
        const profile = Object.values(PROFILES).find((item) => item.buttonId === interaction.customId);
        if (!profile || interaction.guildId !== profile.guildId) return;

        try {
            await sendSignInLink(interaction);
        } catch (error) {
            // If anything goes wrong, always give the member a private reply
            // instead of leaving the button looking like it did nothing.
            console.error("Verification error:", error);
            const content = { title: "Something Went Wrong", body: "Please try again or contact a member of staff." };
            if (interaction.deferred || interaction.replied) await interaction.followUp(ui.message(content, { ephemeral: true })).catch(() => {});
            else await interaction.reply(ui.message(content, { ephemeral: true })).catch(() => {});
        }
    });
}

// The default export is the start-up function above. completeVerification is
// exported separately so the OAuth server (events/oauthServer.js) can call it.
module.exports = register;
module.exports.completeVerification = completeVerification;
