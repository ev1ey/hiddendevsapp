/*
 * ============================================================================
 *  BlueRails Automod
 * ============================================================================
 *
 *  Automatically moderates messages in the main BlueRails Discord server.
 *  Every message is checked against a set of rules. If one is broken:
 *
 *    1. The message is deleted.
 *    2. The member gets an automatic warning, which is recorded as a proper
 *       moderation case and counts towards their moderation points.
 *    3. The bot replies telling them which rule they broke and their new
 *       point total.
 *    4. The violation is logged to a staff channel.
 *    5. If their points reach the ban threshold, they are banned automatically.
 *
 *  The rules fall into three groups:
 *
 *    Content rules (look at a single message):
 *      invite links, links, bad words, pinging too many people, message
 *      length, spam patterns, excessive caps, emoji spam
 *
 *    Rate rules (look at a member's recent messages together):
 *      sticker spam, duplicated text, repeated mentions, sending too fast
 *
 *    Ghost pings:
 *      pinging someone and then quickly deleting the message
 *
 *  Each rule has a "bypass" level in config.js:
 *    "staff" = only Administrators and Staff are exempt
 *    "all"   = Administrators, Staff and the listed bypass roles are exempt
 *
 *  Automod only runs in the main server, and never inside ticket channels.
 * ============================================================================
 */

const { Events, PermissionFlagsBits, AuditLogEvent } = require("discord.js");

// Every limit, bypass role and log channel is set in config.js, so rules can
// be tuned without touching this file.
const config = require("../config");
const store = require("../utils/store");
const ui = require("../utils/ui");

// Two word lists: "swears" (allowed in moderation, up to a limit) and
// "blocked" (never allowed, such as slurs).
const badWords = require("../content/badwords");

// Used to skip ticket channels, where members may need to quote rule breaks.
const { isTicketChannel } = require("../utils/tickets");

// Shared moderation helpers, so automod warnings work exactly like warnings
// given by a member of staff.
const { recordCase, getPoints, formatPoints, notifyThreshold, enforcePoints, thresholdNote } = require("../utils/moderation");

const settings = config.automod;
const rules = settings.rules;

/*
 * ----------------------------------------------------------------------------
 *  Patterns used to detect content
 * ----------------------------------------------------------------------------
 */

// Discord invites, in any of these forms: discord.gg/abc, discord.com/invite/abc
// and the older discordapp.com/invite/abc.
const INVITE_PATTERN = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/i;

// Any web link starting with http://, https:// or www.
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>]+/gi;

// Custom server emojis look like <:name:123> or <a:name:123> when animated.
const CUSTOM_EMOJI_PATTERN = /<a?:\w+:\d+>/g;

// Standard emojis such as smileys and symbols.
const UNICODE_EMOJI_PATTERN = /\p{Extended_Pictographic}/gu;

// "Leetspeak" swaps, so words like "sh1t" or "@ss" are still caught.
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s" };

/*
 * ----------------------------------------------------------------------------
 *  Short-term memory
 * ----------------------------------------------------------------------------
 *  These live in memory only. They're cleared on restart, which is fine
 *  because they only cover the last minute or so of activity.
 */

// Each member's recent messages, used by the rate rules.
const history = new Map();

// Stops one burst of spam turning into many separate warnings. After a
// warning, the same rule only deletes messages for a short while.
const warnCooldowns = new Map();

// Message IDs the bot deleted itself, so the ghost ping check doesn't think
// the member deleted them.
const botDeleted = new Set();

/*
 *  Turns a link into a simple form so allowed links match however they're
 *  written. For example, "https://www.Roblox.com/games/123/" and
 *  "roblox.com/games/123" become identical.
 */
function normaliseLink(url) {
    return url
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/#.*$/, "")
        .replace(/[).,!?]+$/, "")
        .replace(/\/+$/, "");
}

// The approved links from config.js, pre-normalised for fast checking.
const allowedLinks = new Set(rules.links.allowed.map(normaliseLink));

/*
 *  Decides whether a member is exempt from a rule.
 *    - Administrators and Staff are exempt from every rule.
 *    - The extra bypass roles are only exempt from rules marked "all".
 */
function isBypassed(member, rule) {
    if (!member) return false;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    if (member.roles.cache.has(settings.staffRoleId)) return true;
    return rule.bypass === "all" && settings.bypassRoles.some((id) => member.roles.cache.has(id));
}

/*
 *  Gets (or creates) the list of recent messages for one member in one
 *  server. The key combines both IDs so servers are kept separate.
 */
function userHistory(guildId, userId) {
    const key = `${guildId}:${userId}`;
    if (!history.has(key)) history.set(key, []);
    return history.get(key);
}

// Keeps only the entries from the last N seconds.
function recent(entries, seconds, now) {
    return entries.filter((entry) => now - entry.time <= seconds * 1000);
}

// Counts both custom server emojis and standard emojis.
function countEmojis(content) {
    return (content.match(CUSTOM_EMOJI_PATTERN) ?? []).length + (content.match(UNICODE_EMOJI_PATTERN) ?? []).length;
}

/*
 *  Splits a message into lowercase words after undoing leetspeak, so the
 *  bad word check can compare whole words. Comparing whole words avoids
 *  false positives where a bad word appears inside an innocent word.
 */
function words(content) {
    return content
        .toLowerCase()
        .replace(/[013457@$]/g, (char) => LEET[char])
        .split(/[^a-z]+/)
        .filter(Boolean);
}

/*
 *  Removes links and mentions before the caps check, so things like a
 *  pasted URL or an @mention don't count as "shouting".
 */
function stripForCaps(content) {
    return content.replace(URL_PATTERN, "").replace(/<[@#&!:a-z0-9_]+>/gi, "");
}

/*
 * ----------------------------------------------------------------------------
 *  Content rules
 * ----------------------------------------------------------------------------
 *  Checks a single message. Returns the name of the first rule it breaks,
 *  or null if it's fine. The order matters: more serious rules are checked
 *  first, so the warning names the most important problem.
 */
function checkContent(message) {
    const content = message.content ?? "";
    const member = message.member;

    // Discord server invites.
    if (!isBypassed(member, rules.inviteLinks) && INVITE_PATTERN.test(content)) return "inviteLinks";

    // Any other link that isn't on the approved list.
    if (!isBypassed(member, rules.links)) {
        const links = content.match(URL_PATTERN) ?? [];
        if (links.some((link) => !INVITE_PATTERN.test(link) && !allowedLinks.has(normaliseLink(link)))) return "links";
    }

    // Bad words: any "blocked" word is an instant violation. Ordinary swears
    // are tolerated up to a limit (maxSwears) per message.
    if (!isBypassed(member, rules.badWords)) {
        const found = words(content);
        if (found.some((word) => badWords.blocked.includes(word))) return "badWords";
        if (found.filter((word) => badWords.swears.includes(word)).length > rules.badWords.maxSwears) return "badWords";
    }

    // Pinging lots of different people in one message. The sender and bots
    // don't count.
    if (!isBypassed(member, rules.multiUserSpam)) {
        const pinged = message.mentions.users.filter((user) => user.id !== message.author.id && !user.bot);
        if (pinged.size > rules.multiUserSpam.maxUsers) return "multiUserSpam";
    }

    // Very long messages.
    if (!isBypassed(member, rules.maxLength) && content.length > rules.maxLength.maxCharacters) return "maxLength";

    // Spam patterns: the same line repeated, one character held down
    // ("aaaaaaaaaaaaaaaa"), or a wall of empty lines.
    if (!isBypassed(member, rules.spamPatterns)) {
        const rule = rules.spamPatterns;
        const lines = content
            .split("\n")
            .map((line) => line.trim().toLowerCase())
            .filter(Boolean);

        // Count how many times each line appears.
        const counts = new Map();
        for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);

        if ([...counts.values()].some((count) => count > rule.maxRepeatedLines)) return "spamPatterns";
        if (new RegExp(`(.)\\1{${rule.maxRepeatedCharacters},}`, "s").test(content)) return "spamPatterns";
        if ((content.match(/\n/g) ?? []).length > rule.maxLineBreaks) return "spamPatterns";
    }

    // Excessive caps: only checked once a message has enough letters
    // (minLetters), so short replies like "OK" or "LOL" are fine.
    if (!isBypassed(member, rules.caps)) {
        const letters = stripForCaps(content).replace(/[^a-z]/gi, "");
        if (letters.length >= rules.caps.minLetters) {
            const upper = letters.replace(/[^A-Z]/g, "").length;
            if ((upper / letters.length) * 100 >= rules.caps.maxPercent) return "caps";
        }
    }

    // Too many emojis in one message.
    if (!isBypassed(member, rules.emojis) && countEmojis(content) > rules.emojis.maxEmojis) return "emojis";

    return null;
}

/*
 * ----------------------------------------------------------------------------
 *  Rate rules
 * ----------------------------------------------------------------------------
 *  Looks at the member's recent messages together (including the new one)
 *  to catch spam that is spread across several messages.
 */
function checkRate(message, entries, now) {
    const member = message.member;
    const content = (message.content ?? "").trim().toLowerCase();

    // Sending several stickers in a short time.
    if (!isBypassed(member, rules.stickers) && message.stickers.size > 0) {
        if (recent(entries, rules.stickers.perSeconds, now).filter((entry) => entry.sticker).length > rules.stickers.maxMessages) {
            return "stickers";
        }
    }

    // Sending the same text over and over.
    if (!isBypassed(member, rules.duplicates) && content.length > 0) {
        const same = recent(entries, rules.duplicates.perSeconds, now).filter((entry) => entry.content === content);
        if (same.length > rules.duplicates.maxRepeats) return "duplicates";
    }

    // Repeatedly pinging people across several messages.
    if (!isBypassed(member, rules.massMentions) && message.mentions.users.some((user) => user.id !== message.author.id && !user.bot)) {
        if (recent(entries, rules.massMentions.perSeconds, now).filter((entry) => entry.mentions).length > rules.massMentions.maxMessages) {
            return "massMentions";
        }
    }

    // Sending messages too quickly, whatever they say.
    if (!isBypassed(member, rules.antiSpam)) {
        if (recent(entries, rules.antiSpam.perSeconds, now).length > rules.antiSpam.maxMessages) return "antiSpam";
    }

    return null;
}

/*
 * ----------------------------------------------------------------------------
 *  Staff log
 * ----------------------------------------------------------------------------
 *  Posts every automod action to the automod log channel, including a copy
 *  of the original message so staff can see exactly what was removed.
 */
async function sendLog(client, member, rule, channel, caseNumber, points, content, action) {
    const logChannel = await client.channels.fetch(settings.logChannelId).catch(() => null);
    if (!logChannel || !logChannel.isTextBased()) {
        console.error("Automod log channel not found. Check automod.logChannelId in config.js");
        return;
    }

    const unix = Math.floor(Date.now() / 1000);

    await logChannel
        .send(
            ui.logEmbed({
                title: `Automod | ${rule.name} | Case #${caseNumber}`,
                thumbnail: member.displayAvatarURL(),
                fields: [
                    { name: "Member", value: `${member}\n(\`${member.id}\`)` },
                    { name: "Violation", value: rule.name },
                    { name: "Channel", value: `${channel}` },
                    { name: "Points", value: `${points}` },
                    { name: "Action", value: action },
                    { name: "Date", value: `<t:${unix}:f>` },
                    // Trimmed to fit Discord's limit for one embed field.
                    { name: "Message", value: content ? content.slice(0, 1000) : "No text" },
                ],
            })
        )
        .catch((error) => console.error("Could not send automod log:", error));
}

/*
 *  Deletes a message and remembers that the bot did it, so the ghost ping
 *  check ignores it. The reminder is cleared after a minute.
 */
async function deleteMessage(message) {
    botDeleted.add(message.id);
    setTimeout(() => botDeleted.delete(message.id), 60 * 1000);
    await message.delete().catch(() => {});
}

/*
 * ----------------------------------------------------------------------------
 *  Punishing a violation
 * ----------------------------------------------------------------------------
 *  Shared by every rule. "alreadyDeleted" is true for ghost pings, where the
 *  member deleted the message themselves, so there's nothing left to delete
 *  or reply to.
 */
async function punish(message, ruleKey, { alreadyDeleted = false } = {}) {
    const rule = rules[ruleKey];
    const member = message.member;
    const now = Date.now();

    // One cooldown per member, per rule, per server.
    const cooldownKey = `${message.guild.id}:${member.id}:${ruleKey}`;

    /*
     *  If they were warned for this same rule a few seconds ago, just remove
     *  the message quietly. This stops a burst of spam turning into ten
     *  warnings (and an unfair automatic ban) in one go.
     */
    if ((warnCooldowns.get(cooldownKey) ?? 0) > now) {
        if (!alreadyDeleted) await deleteMessage(message);
        return;
    }
    warnCooldowns.set(cooldownKey, now + settings.warnCooldownSeconds * 1000);

    /*
     *  Record the warning as a real moderation case. "automod: true" marks it
     *  as automatic, and it still counts towards points. Staff can view it in
     *  the member's mod logs and remove it with the void command.
     */
    const reason = `Automod: ${rule.name}`;
    const caseNumber = recordCase(message.guild.id, {
        type: "Warn",
        userId: member.id,
        moderatorId: message.client.user.id,
        reason,
        automod: true,
    });

    // Also add it to the member's warning list, so it shows in /warnings
    // just like a warning from staff.
    const warnings = store.read("warnings");
    warnings[message.guild.id] ??= {};
    warnings[message.guild.id][member.id] ??= [];
    warnings[message.guild.id][member.id].push({
        case: caseNumber,
        reason,
        moderatorId: message.client.user.id,
        createdAt: new Date(now).toISOString(),
    });
    store.write("warnings", warnings);

    /*
     *  Work out their new point total. If it has reached the threshold,
     *  notifyThreshold() DMs them and enforcePoints() bans them permanently.
     *  "banned" tells us whether that happened, for the reply below.
     */
    const points = getPoints(message.guild.id, member.id);
    await notifyThreshold(member, points);
    const banned = await enforcePoints({ guild: message.guild, client: message.client }, member.user, points);

    // Build the public warning, worded differently for ghost pings.
    const what = alreadyDeleted
        ? `you pinged someone and then deleted your message, which breaks the **${rule.name}** rule`
        : `your message broke the **${rule.name}** rule and has been removed`;
    const text = `${member}, ${what}. This is an automatic warning, and you now have ${formatPoints(points)}.${thresholdNote(banned)}`;

    // Only ping the member being warned, never anyone else in the message.
    const payload = { content: text, allowedMentions: { users: [member.id], repliedUser: true } };

    if (alreadyDeleted) {
        // The message is gone, so post the warning in the channel instead.
        await message.channel.send(payload).catch(() => {});
    } else {
        // Reply to the message first so the warning is clearly linked to it,
        // then delete it. If replying fails, post in the channel instead.
        const replied = await message.reply(payload).catch(() => null);
        if (!replied) await message.channel.send(payload).catch(() => {});
        await deleteMessage(message);
    }

    await sendLog(message.client, member, rule, message.channel, caseNumber, points, message.content, alreadyDeleted ? "Warned" : "Message deleted and warned");
}

/*
 * ----------------------------------------------------------------------------
 *  Ghost ping helper
 * ----------------------------------------------------------------------------
 *  When a message disappears, it might have been deleted by the member who
 *  sent it (a ghost ping) or by a moderator. This checks Discord's audit log
 *  for a recent deletion by someone else in the same channel. If a moderator
 *  removed it, the member isn't punished.
 */
async function wasDeletedByOthers(message) {
    const logs = await message.guild
        .fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 5 })
        .catch(() => null);
    if (!logs) return false;

    return logs.entries.some(
        (entry) =>
            entry.target?.id === message.author.id &&
            entry.extra?.channel?.id === message.channel.id &&
            Date.now() - entry.createdTimestamp < 10 * 1000
    );
}

/*
 * ----------------------------------------------------------------------------
 *  Wiring it all up
 * ----------------------------------------------------------------------------
 *  index.js calls this once at start-up with the Discord client.
 */
module.exports = (client) => {
    /*
     *  Every new message.
     *  Ignored if it's: a DM, from another server, from a bot, from a
     *  member that couldn't be loaded, or inside a ticket channel.
     */
    client.on(Events.MessageCreate, async (message) => {
        if (!message.guild || message.guild.id !== config.guilds.main || message.author.bot || !message.member) return;
        if (isTicketChannel(message.channelId)) return;

        try {
            const now = Date.now();

            // Add this message to the member's recent history for the rate rules.
            const entries = userHistory(message.guild.id, message.author.id);
            entries.push({
                time: now,
                content: (message.content ?? "").trim().toLowerCase(),
                sticker: message.stickers.size > 0,
                mentions: message.mentions.users.some((user) => user.id !== message.author.id && !user.bot),
            });

            // Only keep the last 60 seconds, so memory use stays small.
            const kept = recent(entries, 60, now);
            entries.length = 0;
            entries.push(...kept);

            // Content rules first, then rate rules. The first rule broken wins.
            const violation = checkContent(message) ?? checkRate(message, entries, now);
            if (violation) await punish(message, violation);
        } catch (error) {
            // One bad message should never crash automod for everyone else.
            console.error("Automod error:", error);
        }
    });

    /*
     *  Every deleted message, used to catch ghost pings.
     *
     *  "partial" means Discord only sent the message ID without its content
     *  (it was sent before the bot started), so it can't be checked.
     */
    client.on(Events.MessageDelete, async (message) => {
        if (message.partial || !message.guild || message.guild.id !== config.guilds.main || message.author?.bot || !message.member) return;

        // Skip messages automod deleted itself, and ticket channels.
        if (botDeleted.has(message.id) || isTicketChannel(message.channelId)) return;
        if (isBypassed(message.member, rules.ghostMentions)) return;

        // Only count it as a ghost ping if it was deleted soon after being sent.
        if (Date.now() - message.createdTimestamp > rules.ghostMentions.withinSeconds * 1000) return;

        // It must actually have pinged another person.
        const pinged = message.mentions.users.filter((user) => user.id !== message.author.id && !user.bot);
        if (pinged.size === 0) return;

        try {
            // Don't punish the member if a moderator deleted it.
            if (await wasDeletedByOthers(message)) return;
            await punish(message, "ghostMentions", { alreadyDeleted: true });
        } catch (error) {
            console.error("Automod ghost mention error:", error);
        }
    });
};
