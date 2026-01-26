/**
 * Arc: combat-chickens
 * Character: Adam_3
 *
 * Goal: Train combat by killing chickens.
 * Strategy: Attack chickens, collect bones, bury for Prayer XP.
 * Duration: 5 minutes
 *
 * No tools required - just need existing combat gear!
 */

import { runArc, StallError } from '../../../arc-runner';
import type { ScriptContext } from '../../../arc-runner';

// Target levels
const TARGET_ATTACK = 20;
const TARGET_STRENGTH = 20;

interface Stats {
    killCount: number;
    bonesBuried: number;
    startTime: number;
    lastProgressTime: number;
}

function markProgress(ctx: ScriptContext, stats: Stats): void {
    stats.lastProgressTime = Date.now();
    ctx.progress();
}

function getAttackLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Attack')?.baseLevel ?? 1;
}

function getStrengthLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Strength')?.baseLevel ?? 1;
}

function getDefenceLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Defence')?.baseLevel ?? 1;
}

function getHitpointsLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Hitpoints')?.baseLevel ?? 10;
}

function getPrayerLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Prayer')?.baseLevel ?? 1;
}

function getTotalLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.reduce((sum, s) => sum + s.baseLevel, 0) ?? 30;
}

function isInCombat(ctx: ScriptContext): boolean {
    const state = ctx.state();
    if (!state) return false;
    // Check if player is animating (in combat) - animId !== -1 means active animation
    return (state.player?.animId ?? -1) !== -1;
}

/**
 * Find a chicken to attack
 */
function findChicken(ctx: ScriptContext) {
    const state = ctx.state();
    if (!state) return null;

    const targets = state.nearbyNpcs
        .filter(npc => /^(chicken|duck|imp)$/i.test(npc.name))
        .filter(npc => npc.options.some(opt => /attack/i.test(opt)))
        .sort((a, b) => a.distance - b.distance);

    return targets[0] ?? null;
}

/**
 * Bury all bones in inventory
 */
async function buryBones(ctx: ScriptContext, stats: Stats): Promise<number> {
    const state = ctx.state();
    if (!state) return 0;

    let buried = 0;
    const bones = state.inventory.filter(item => /bones/i.test(item.name));

    for (const item of bones) {
        ctx.log(`Burying ${item.name}`);
        // Use bone (bury option is usually first - option index is 1-based)
        await ctx.sdk.sendUseItem(item.slot, 1); // 1 = first option (Bury)
        buried++;
        markProgress(ctx, stats);
        await new Promise(r => setTimeout(r, 600));
    }

    return buried;
}

/**
 * Main combat loop
 */
async function combatLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    let loopCount = 0;
    let noTargetCount = 0;

    while (getAttackLevel(ctx) < TARGET_ATTACK || getStrengthLevel(ctx) < TARGET_STRENGTH) {
        loopCount++;
        const currentState = ctx.state();
        if (!currentState) {
            ctx.warn('Lost game state');
            break;
        }

        const attackLevel = getAttackLevel(ctx);
        const strengthLevel = getStrengthLevel(ctx);
        const hpLevel = getHitpointsLevel(ctx);

        // Progress log every 20 loops
        if (loopCount % 20 === 0) {
            ctx.log(`Loop ${loopCount}: Atk=${attackLevel}, Str=${strengthLevel}, HP=${hpLevel}, Kills=${stats.killCount}`);
        }

        // Dismiss any dialogs
        if (currentState.dialog.isOpen) {
            await ctx.bot.dismissBlockingUI();
            markProgress(ctx, stats);
            continue;
        }

        // Bury bones if inventory has 5+ bones
        const boneCount = currentState.inventory.filter(i => /bones/i.test(i.name)).length;
        if (boneCount >= 5) {
            ctx.log(`Burying ${boneCount} bones`);
            stats.bonesBuried += await buryBones(ctx, stats);
            continue;
        }

        // If in combat, wait
        if (isInCombat(ctx)) {
            markProgress(ctx, stats);
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }

        // Find a target
        const target = findChicken(ctx);
        if (!target) {
            noTargetCount++;
            if (noTargetCount % 10 === 0) {
                ctx.log(`No targets nearby, wandering... (${noTargetCount})`);
            }

            // Wander to find targets
            const player = currentState.player;
            if (player) {
                const dx = Math.floor(Math.random() * 10) - 5;
                const dz = Math.floor(Math.random() * 10) - 5;
                await ctx.sdk.sendWalk(player.worldX + dx, player.worldZ + dz);
                markProgress(ctx, stats);
                await new Promise(r => setTimeout(r, 2000));
            }
            continue;
        }

        noTargetCount = 0;

        // Find attack option
        const attackOpt = target.optionsWithIndex.find(o => /attack/i.test(o.text));
        if (!attackOpt) {
            ctx.warn('Target has no attack option');
            await new Promise(r => setTimeout(r, 500));
            continue;
        }

        // Attack!
        ctx.log(`Attacking ${target.name}`);
        await ctx.sdk.sendInteractNpc(target.index, attackOpt.opIndex);
        stats.killCount++;
        markProgress(ctx, stats);

        // Wait for combat
        await new Promise(r => setTimeout(r, 3000));
    }

    ctx.log(`Training complete! Attack=${getAttackLevel(ctx)}, Strength=${getStrengthLevel(ctx)}`);
}

/**
 * Log final statistics
 */
function logFinalStats(ctx: ScriptContext, stats: Stats): void {
    const attackLevel = getAttackLevel(ctx);
    const strengthLevel = getStrengthLevel(ctx);
    const defenceLevel = getDefenceLevel(ctx);
    const hpLevel = getHitpointsLevel(ctx);
    const prayerLevel = getPrayerLevel(ctx);
    const totalLevel = getTotalLevel(ctx);
    const duration = (Date.now() - stats.startTime) / 1000;

    ctx.log('');
    ctx.log('=== Arc Results ===');
    ctx.log(`Duration: ${Math.round(duration)}s`);
    ctx.log(`Attack Level: ${attackLevel}`);
    ctx.log(`Strength Level: ${strengthLevel}`);
    ctx.log(`Defence Level: ${defenceLevel}`);
    ctx.log(`Hitpoints Level: ${hpLevel}`);
    ctx.log(`Prayer Level: ${prayerLevel}`);
    ctx.log(`Kills: ${stats.killCount}`);
    ctx.log(`Bones Buried: ${stats.bonesBuried}`);
    ctx.log(`Total Level: ${totalLevel}`);
    ctx.log('');
}

// Run the arc
runArc({
    characterName: 'Adam_3',
    arcName: 'combat-chickens',
    goal: `Train combat to Attack ${TARGET_ATTACK}, Strength ${TARGET_STRENGTH}`,
    timeLimit: 5 * 60 * 1000,      // 5 minutes
    stallTimeout: 45_000,          // 45 seconds
    screenshotInterval: 30_000,
}, async (ctx) => {
    const stats: Stats = {
        killCount: 0,
        bonesBuried: 0,
        startTime: Date.now(),
        lastProgressTime: Date.now(),
    };

    ctx.log('=== Arc: combat-chickens ===');
    ctx.log(`Starting Attack: ${getAttackLevel(ctx)}, Strength: ${getStrengthLevel(ctx)}`);
    ctx.log(`Target: Attack ${TARGET_ATTACK}, Strength ${TARGET_STRENGTH}`);
    ctx.log(`Position: (${ctx.state()?.player?.worldX}, ${ctx.state()?.player?.worldZ})`);

    // Dismiss any startup dialogs
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
