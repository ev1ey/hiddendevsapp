/*
 * ============================================================================
 *  /getroles (and !getroles) Command
 * ============================================================================
 *
 *  Lets a verified member collect the Discord roles that match their Roblox
 *  account, without needing a member of staff to hand them out.
 *
 *  It checks two things using the Roblox account they linked during
 *  verification:
 *
 *    1. Are they in the BlueRails Roblox group?
 *       If so, they get the group member role.
 *
 *    2. Do they own any of our listed game passes?
 *       Each game pass in config.js is paired with a Discord role, and owning
 *       the pass gives that role.
 *
 *  Every use is logged to a staff channel.
 *
 *  Like every command in this bot, it has a slash version and a "!" prefix
 *  version. The shared command loader (events/commands.js) handles
 *  permissions, then calls fromSlash() or fromPrefix() to read the options,
 *  and finally run() to do the work.
 * ============================================================================
 */

// Builds the slash command definition that Discord shows in the "/" menu.
const { SlashCommandBuilder } = require("discord.js");

// Channel IDs, role IDs, the group ID and the game pass list all live here.
const config = require("../../config");

// JSON file storage. Used here to read which Roblox account each member linked.
const store = require("../../utils/store");

// Shared helpers for the light-blue message cards and compact log embeds.
const ui = require("../../utils/ui");

// Returns true if a member has the Staff role. Staff may use the command in
// any channel, while everyone else must use the dedicated channel.
const { isStaff } = require("../../utils/moderation");

// Small wrappers around Roblox's public APIs (see utils/roblox.js).
const { getGroupMembership, ownsGamepass } = require("../../utils/roblox");

/*
 * ----------------------------------------------------------------------------
 *  Staff log
 * ----------------------------------------------------------------------------
 *  Records who ran the command, their linked Roblox account, their rank in
 *  the group, the result of each game pass check, and which roles were added.
 */
async function sendLog(ctx, verification, membership, passes, rolesAdded) {
    const channel = await ctx.client.channels.fetch(config.getroles.logChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        console.error("Getroles log channel not found. Check getroles.logChannelId in config.js");
        return;
    }

    // Discord timestamp, shown in each viewer's own time zone.
    const unix = Math.floor(Date.now() / 1000);

    /*
     *  Each game pass check has four possible results:
     *    true      = they own it
     *    false     = they don't own it
     *    null      = their Roblox inventory is private, so it couldn't be checked
     *    undefined = Roblox couldn't be reached
     *  This turns those into readable text for the log.
     */
    const passText = passes
        .map((pass) => `\`${pass.id}\`: ${pass.owned === null ? "Inventory private" : pass.owned === undefined ? "Check failed" : pass.owned ? "Owned" : "Not owned"}`)
        .join("\n");

    await channel
        .send(
            ui.logEmbed({
                title: "Roles Checked",
                thumbnail: ctx.user.displayAvatarURL(),
                fields: [
                    { name: "Member", value: `${ctx.user}\n(\`${ctx.user.id}\`)` },
                    {
                        name: "Roblox",
                        value: `[${verification.robloxName}](https://www.roblox.com/users/${verification.robloxId}/profile)\n(\`${verification.robloxId}\`)`,
                    },
                    { name: "Group Rank", value: membership ? membership.roleName : "Not in group" },
                    { name: "Gamepasses", value: passText || "None" },
                    // <@&ID> displays as a clickable role mention.
                    { name: "Roles Added", value: rolesAdded.length ? rolesAdded.map((id) => `<@&${id}>`).join("\n") : "None" },
                    { name: "Channel", value: `${ctx.channel}` },
                    { name: "Date", value: `<t:${unix}:f>` },
                ],
            })
        )
        // A failed log shouldn't stop the member getting their roles.
        .catch((error) => console.error("Could not send getroles log:", error));
}

/*
 * ----------------------------------------------------------------------------
 *  Giving a single role safely
 * ----------------------------------------------------------------------------
 *  - Skips the role if the member already has it, so nothing is logged twice
 *    and Discord isn't asked to do unnecessary work.
 *  - Records the role in rolesAdded if it worked, or in failed if it didn't
 *    (usually because the bot's role is lower than the role it's giving).
 *  - One failed role doesn't stop the others being given.
 */
async function giveRole(ctx, roleId, reason, rolesAdded, failed) {
    if (ctx.member.roles.cache.has(roleId)) return;
    try {
        await ctx.member.roles.add(roleId, reason);
        rolesAdded.push(roleId);
    } catch (error) {
        console.error(`Could not add role ${roleId}:`, error);
        failed.push(roleId);
    }
}

module.exports = {
    // The command's name, used by the loader and for "!getroles".
    name: "getroles",

    // What Discord shows in the slash command menu.
    data: new SlashCommandBuilder().setName("getroles").setDescription("Get the Discord roles that match your Roblox account"),

    // This command takes no options, so both versions return an empty object.
    async fromSlash() {
        return {};
    },

    async fromPrefix() {
        return {};
    },

    async run(ctx) {
        /*
         *  Channel restriction.
         *  Members must use the dedicated get-roles channel to keep other
         *  channels tidy. Staff are allowed to use it anywhere.
         */
        if (ctx.channel.id !== config.getroles.channelId && !isStaff(ctx.member)) {
            return ctx.reply(
                ui.message({ title: "Wrong Channel", body: `Please use this command in <#${config.getroles.channelId}>.` }),
                { ephemeral: true }
            );
        }

        /*
         *  Find the Roblox account this member linked during verification.
         *  If they haven't verified, there's nothing to check, so point them
         *  to the verification channel.
         */
        const verification = store.read("verifications")[ctx.user.id];
        if (!verification) {
            return ctx.reply(
                ui.message({
                    title: "Not Verified",
                    body: `You need to verify your Roblox account first. Head to <#${config.verification.channelId}> and click **Verification**.`,
                }),
                { ephemeral: true }
            );
        }

        /*
         *  Check 1: group membership.
         *  Returns { rank, roleName } if they're in the group, or null if not.
         *  If Roblox is down, stop and ask them to try later instead of
         *  wrongly telling them they're not in the group.
         */
        let membership;
        try {
            membership = await getGroupMembership(verification.robloxId, config.roblox.groupId);
        } catch (error) {
            console.error("Roblox group lookup failed:", error);
            return ctx.reply(
                ui.message({ title: "Roblox Unavailable", body: "I couldn't reach Roblox right now. Please try again in a minute." }),
                { ephemeral: true }
            );
        }

        /*
         *  Check 2: game pass ownership.
         *  Goes through every { id, roleId } pair in config.roblox.gamepasses.
         *  Unlike the group check, a failure here doesn't stop the command.
         *  The result is recorded (see the four results described in sendLog)
         *  so the member can still get their group role.
         */
        const passes = [];
        for (const pass of config.roblox.gamepasses) {
            let owned;
            try {
                owned = await ownsGamepass(verification.robloxId, pass.id);
            } catch (error) {
                console.error(`Gamepass lookup failed for ${pass.id}:`, error);
                owned = undefined;
            }
            passes.push({ ...pass, owned });
        }

        // Keep track of what worked and what didn't, for the reply and the log.
        const rolesAdded = [];
        const failed = [];

        // Give the group role if they're in the group.
        if (membership) {
            await giveRole(ctx, config.roblox.groupMemberRoleId, `In BlueRails group as ${membership.roleName}`, rolesAdded, failed);
        }

        // Give each game pass role they qualify for.
        for (const pass of passes) {
            if (pass.owned) await giveRole(ctx, pass.roleId, `Owns gamepass ${pass.id}`, rolesAdded, failed);
        }

        /*
         *  Build one clear reply that covers every outcome:
         *    - which roles they received, or that they're already up to date
         *    - a link to join the group if they aren't in it
         *    - how to fix a private inventory
         *    - a note if Roblox couldn't be checked
         *    - a note to contact staff if a role couldn't be given
         */
        const lines = [];
        if (rolesAdded.length) {
            lines.push(`You have been given ${rolesAdded.map((id) => `<@&${id}>`).join(", ")}.`);
        } else if (!failed.length) {
            lines.push("Your roles are already **up to date**.");
        }
        if (!membership) {
            lines.push(`You aren't in the **BlueRails** Roblox group yet. Join it here, then run this command again: <${config.roblox.groupUrl}>`);
        }
        if (passes.some((pass) => pass.owned === null)) {
            lines.push("Your Roblox inventory is **private**, so I couldn't check your gamepasses. Set your inventory to public in your Roblox privacy settings, then run this command again.");
        }
        if (passes.some((pass) => pass.owned === undefined)) {
            lines.push("I couldn't check your gamepasses right now. Please try again in a minute.");
        }
        if (failed.length) {
            lines.push("I couldn't give you some of your roles. Please contact a member of staff.");
        }

        // allowedMentions: { parse: [] } shows role mentions without pinging
        // everyone who has those roles.
        await ctx.reply({ content: lines.join("\n"), allowedMentions: { parse: [] } });
        await sendLog(ctx, verification, membership, passes, rolesAdded);
    },
};
