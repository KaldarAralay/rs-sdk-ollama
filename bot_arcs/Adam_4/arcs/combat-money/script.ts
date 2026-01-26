/**
 * Arc: combat-money
 * Character: Adam_4
 *
 * Goal: Train combat and make money.
 * Start fresh with Lumbridge spawn, walk to goblins, train combat.
 */

import { runArc, TestPresets, StallError } from '../../../arc-runner';
import type { ScriptContext } from '../../../arc-runner';

interface Stats {
    kills: number;
    coinsCollected: number;
    startTime: number;
    lastProgressTime: number;
}

function markProgress(ctx: ScriptContext, stats: Stats): void {
    stats.lastProgressTime = Date.now();
    ctx.progress();
}

function getAttackLevel(ctx: ScriptContext): number {
    return ctx.sdk.getSkill('Attack')?.baseLevel ?? 1;
}

function getStrengthLevel(ctx: ScriptContext): number {
    return ctx.sdk.getSkill('Strength')?.baseLevel ?? 1;
}

function getDefenceLevel(ctx: ScriptContext): number {
    return ctx.sdk.getSkill('Defence')?.baseLevel ?? 1;
}

function getTotalLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.reduce((sum, s) => sum + s.baseLevel, 0) ?? 30;
}

function getCoins(ctx: ScriptContext): number {
    const coins = ctx.state()?.inventory.find(i => /coins/i.test(i.name));
    return coins?.count ?? 0;
}

async function combatLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    const sdk = ctx.sdk;
    let turn = 0;
    let currentStyleIndex = 0;
    const styleRotation = ['Strength', 'Attack', 'Defence']; // Rotate through skills

    // Equip weapon
    const sword = sdk.getInventory().find(i => /sword|scimitar|dagger/i.test(i.name));
    if (sword) {
        const wieldOpt = sword.optionsWithIndex.find(o => /wield|wear/i.test(o.text));
        if (wieldOpt) {
            ctx.log(`Equipping ${sword.name}`);
            await sdk.sendUseItem(sword.slot, wieldOpt.opIndex);
            await new Promise(r => setTimeout(r, 500));
        }
    }

    // Helper to set combat style
    const setStyle = async (skillName: string) => {
        const styleState = sdk.getState()?.combatStyle;
        if (styleState) {
            const style = styleState.styles.find(s => s.trainedSkill === skillName);
            if (style) {
                await sdk.sendSetCombatStyle(style.index);
                ctx.log(`Combat style: ${skillName}`);
            }
        }
    };

    await new Promise(r => setTimeout(r, 300));
    const firstStyle = styleRotation[0];
    if (firstStyle) await setStyle(firstStyle);

    // Walk to goblin area (east of Lumbridge)
    const state0 = sdk.getState();
    const startX = state0?.player?.worldX ?? 3222;
    const startZ = state0?.player?.worldZ ?? 3218;
    ctx.log(`Walking to goblin area...`);
    await ctx.bot.walkTo(startX + 20, startZ);
    markProgress(ctx, stats);

    while (turn < 500) {
        turn++;
        const state = sdk.getState();
        if (!state) break;

        // Log progress
        if (turn % 20 === 0) {
            const atk = getAttackLevel(ctx);
            const str = getStrengthLevel(ctx);
            const coins = getCoins(ctx);
            ctx.log(`Turn ${turn}: Atk=${atk}, Str=${str}, Kills=${stats.kills}, GP=${coins}`);
        }

        // Dismiss dialogs
        if (state.dialog.isOpen) {
            await ctx.bot.dismissBlockingUI();
            markProgress(ctx, stats);
            continue;
        }

        // Rotate combat style every 50 turns
        if (turn % 50 === 0 && turn > 0) {
            currentStyleIndex = (currentStyleIndex + 1) % styleRotation.length;
            const style = styleRotation[currentStyleIndex];
            if (style) await setStyle(style);
        }

        // Try to pick up ground loot first (use groundItems, not nearbyLocs!)
        const loot = sdk.getGroundItems()
            .filter(i => /coins|bones|feather|arrow|rune/i.test(i.name))
            .filter(i => i.distance <= 5)
            .sort((a, b) => {
                // Prioritize coins
                if (/coins/i.test(a.name) && !/coins/i.test(b.name)) return -1;
                if (/coins/i.test(b.name) && !/coins/i.test(a.name)) return 1;
                return a.distance - b.distance;
            });

        if (loot.length > 0 && state.inventory.length < 26) {
            const item = loot[0]!;
            const result = await ctx.bot.pickupItem(item);
            if (result.success && /coins/i.test(item.name)) {
                stats.coinsCollected += item.count ?? 1;
                ctx.log(`Picked up ${item.count} coins!`);
            }
            markProgress(ctx, stats);
            await new Promise(r => setTimeout(r, 500));
            continue;
        }

        // Find target
        const npcs = sdk.getNearbyNpcs();
        const target = npcs.find(n =>
            /goblin|chicken|rat|spider|man|woman/i.test(n.name) &&
            n.optionsWithIndex.some(o => /attack/i.test(o.text))
        );

        if (target) {
            const attackOpt = target.optionsWithIndex.find(o => /attack/i.test(o.text));
            if (attackOpt) {
                await sdk.sendInteractNpc(target.index, attackOpt.opIndex);
                stats.kills++;
                markProgress(ctx, stats);
            }
            await new Promise(r => setTimeout(r, 1500));
        } else {
            // Wander to find targets
            const px = state.player?.worldX ?? startX;
            const pz = state.player?.worldZ ?? startZ;
            const dx = Math.floor(Math.random() * 10) - 5;
            const dz = Math.floor(Math.random() * 10) - 5;
            await ctx.bot.walkTo(px + dx, pz + dz);
            markProgress(ctx, stats);
            await new Promise(r => setTimeout(r, 1000));
        }

        await new Promise(r => setTimeout(r, 600));
    }
}

function logFinalStats(ctx: ScriptContext, stats: Stats): void {
    const atk = getAttackLevel(ctx);
    const str = getStrengthLevel(ctx);
    const def = getDefenceLevel(ctx);
    const coins = getCoins(ctx);
    const totalLevel = getTotalLevel(ctx);
    const duration = (Date.now() - stats.startTime) / 1000;

    ctx.log('');
    ctx.log('=== Arc Results ===');
    ctx.log(`Duration: ${Math.round(duration)}s`);
    ctx.log(`Attack: ${atk}, Strength: ${str}, Defence: ${def}`);
    ctx.log(`Kills: ${stats.kills}`);
    ctx.log(`Coins: ${coins}`);
    ctx.log(`Total Level: ${totalLevel}`);
    ctx.log('');
}

runArc({
    characterName: 'Adam_4',
    arcName: 'combat-money',
    goal: 'Train combat and make money',
    timeLimit: 5 * 60 * 1000,
    stallTimeout: 60_000,
    screenshotInterval: 30_000,
    // Continue with existing save (don't reset!)
}, async (ctx) => {
    const stats: Stats = {
        kills: 0,
        coinsCollected: 0,
        startTime: Date.now(),
        lastProgressTime: Date.now(),
    };

    ctx.log('=== Arc: combat-money (Adam_4) ===');
    ctx.log(`Starting fresh from Lumbridge`);
    ctx.log(`Position: (${ctx.state()?.player?.worldX}, ${ctx.state()?.player?.worldZ})`);

    await ctx.bot.dismissBlockingUI();
    markProgress(ctx, stats);

    try {
        await combatLoop(ctx, stats);
    } catch (e) {
        if (e instanceof StallError) {
            ctx.error(`Arc aborted: ${e.message}`);
        } else {
            throw e;
        }
    } finally {
        logFinalStats(ctx, stats);
    }
});
