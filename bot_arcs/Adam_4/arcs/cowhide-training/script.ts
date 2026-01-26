/**
 * Arc: cowhide-training
 * Character: Adam_4
 *
 * Goal: Kill cows, collect cowhides (~100gp each).
 * Strategy:
 * 1. Fight cows at Lumbridge cow field
 * 2. Pick up cowhides
 * 3. When inventory full, drop hides (can't bank yet)
 * 4. Track total collected for scoring
 *
 * Duration: 5 minutes
 */

import { runArc, StallError } from '../../../arc-runner';
import type { ScriptContext } from '../../../arc-runner';
import type { NearbyNpc } from '../../../../agent/types';

// Locations
const COW_FIELD = { x: 3253, z: 3270 };  // Lumbridge cow field

interface Stats {
    kills: number;
    hidesCollected: number;
    hidesDropped: number;
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

function countHides(ctx: ScriptContext): number {
    const state = ctx.state();
    if (!state) return 0;
    return state.inventory.filter(i => /cow\s*hide/i.test(i.name)).reduce((sum, i) => sum + i.count, 0);
}

function getCoins(ctx: ScriptContext): number {
    const coins = ctx.state()?.inventory.find(i => /coins/i.test(i.name));
    return coins?.count ?? 0;
}

/**
 * Find best cow to attack (not in combat, closest)
 */
function findCow(ctx: ScriptContext): NearbyNpc | null {
    const state = ctx.state();
    if (!state) return null;

    const cows = state.nearbyNpcs
        .filter(npc => /^cow$/i.test(npc.name))
        .filter(npc => npc.optionsWithIndex.some(o => /attack/i.test(o.text)))
        .filter(npc => !npc.inCombat || npc.targetIndex === -1)
        .sort((a, b) => a.distance - b.distance);

    return cows[0] ?? null;
}

/**
 * Pick up cowhides and coins from ground
 */
async function pickupLoot(ctx: ScriptContext, stats: Stats): Promise<number> {
    let pickedUp = 0;
    const state = ctx.state();
    if (!state || state.inventory.length >= 28) return 0;

    // Only pick up valuable items (hides, coins) - skip bones
    const groundItems = ctx.sdk.getGroundItems()
        .filter(i => /cow\s*hide|coins/i.test(i.name))
        .filter(i => i.distance <= 10)
        .sort((a, b) => {
            // Prioritize: hides > coins
            const priority = (name: string) => {
                if (/cow\s*hide/i.test(name)) return 0;
                return 1;  // coins
            };
            return priority(a.name) - priority(b.name) || a.distance - b.distance;
        });

    for (const item of groundItems.slice(0, 3)) {
        if (ctx.state()!.inventory.length >= 28) break;

        const result = await ctx.bot.pickupItem(item);
        if (result.success) {
            pickedUp++;
            if (/cow\s*hide/i.test(item.name)) {
                stats.hidesCollected++;
                ctx.log(`Picked up cowhide! (total: ${stats.hidesCollected})`);
            } else if (/coins/i.test(item.name)) {
                stats.coinsCollected += item.count ?? 1;
                ctx.log(`Picked up ${item.count} coins!`);
            }
            markProgress(ctx, stats);
        }
        await new Promise(r => setTimeout(r, 400));
    }

    return pickedUp;
}

/**
 * Main combat loop
 */
async function cowLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    ctx.log('=== Cowhide Training Started ===');
    let loopCount = 0;
    let noCowCount = 0;
    let currentStyleIndex = 0;
    const styleRotation = ['Strength', 'Attack', 'Defence'];

    // Set initial combat style
    const setStyle = async (skillName: string) => {
        const styleState = ctx.sdk.getState()?.combatStyle;
        if (styleState) {
            const style = styleState.styles.find(s => s.trainedSkill === skillName);
            if (style) {
                await ctx.sdk.sendSetCombatStyle(style.index);
                ctx.log(`Combat style: ${skillName}`);
            }
        }
    };
    const firstStyle = styleRotation[0];
    if (firstStyle) await setStyle(firstStyle);

    while (true) {
        loopCount++;
        if (loopCount % 30 === 0) {
            ctx.log(`Turn ${loopCount}: Kills=${stats.kills}, Hides=${stats.hidesCollected}, GP=${getCoins(ctx)}`);
        }

        // Rotate combat style every 100 loops
        if (loopCount % 100 === 0) {
            currentStyleIndex = (currentStyleIndex + 1) % styleRotation.length;
            const style = styleRotation[currentStyleIndex];
            if (style) await setStyle(style);
        }

        const currentState = ctx.state();
        if (!currentState) break;

        // Dismiss dialogs
        if (currentState.dialog.isOpen) {
            await ctx.bot.dismissBlockingUI();
            markProgress(ctx, stats);
            continue;
        }

        // Pick up nearby loot (but only after attacking, not as primary action)
        // Limited to 1 pickup per iteration to not get stuck in loot loop

        // Drop excess items when inventory near full
        if (currentState.inventory.length >= 26) {
            // First log what's in inventory (once per 100 loops)
            if (loopCount % 100 === 1) {
                const items = currentState.inventory.map(i => i.name).join(', ');
                ctx.log(`Inventory (${currentState.inventory.length}): ${items}`);
            }

            const hides = currentState.inventory.filter(i => /cow\s*hide/i.test(i.name));
            if (hides.length > 0) {
                ctx.log(`Dropping ${hides.length} cowhides to continue training...`);
                for (const hide of hides) {
                    await ctx.sdk.sendDropItem(hide.slot);
                    stats.hidesDropped += hide.count;
                    await new Promise(r => setTimeout(r, 200));
                }
                markProgress(ctx, stats);
                continue;
            }

            // Drop bones if inventory still full
            const bones = currentState.inventory.filter(i => /bones/i.test(i.name));
            if (bones.length > 0) {
                ctx.log(`Dropping ${bones.length} bones...`);
                for (const bone of bones.slice(0, 5)) {  // Drop max 5 at a time
                    await ctx.sdk.sendDropItem(bone.slot);
                    await new Promise(r => setTimeout(r, 200));
                }
                markProgress(ctx, stats);
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
            // Inventory full with essential items - can't drop, proceed anyway
        }

        // Check drift from cow field
        const player = currentState.player;
        if (player) {
            const dist = Math.sqrt(
                Math.pow(player.worldX - COW_FIELD.x, 2) +
                Math.pow(player.worldZ - COW_FIELD.z, 2)
            );
            if (dist > 30) {
                ctx.log(`Drifted ${dist.toFixed(0)} tiles, returning to cow field...`);
                await ctx.bot.walkTo(COW_FIELD.x, COW_FIELD.z);
                markProgress(ctx, stats);
                continue;
            }
        }

        // Find cow to attack
        const cow = findCow(ctx);
        if (!cow) {
            noCowCount++;
            if (noCowCount % 10 === 0) {
                const px = player?.worldX ?? COW_FIELD.x;
                const pz = player?.worldZ ?? COW_FIELD.z;
                await ctx.sdk.sendWalk(px + (Math.random() * 10 - 5), pz + (Math.random() * 10 - 5), true);
            }
            markProgress(ctx, stats);
            await new Promise(r => setTimeout(r, 600));
            continue;
        }

        noCowCount = 0;

        // Attack cow if idle
        const isIdle = player?.animId === -1 && !player?.combat?.inCombat;

        if (isIdle) {
            const attackOpt = cow.optionsWithIndex.find(o => /attack/i.test(o.text));
            if (attackOpt) {
                await ctx.sdk.sendInteractNpc(cow.index, attackOpt.opIndex);
                stats.kills++;
                markProgress(ctx, stats);

                // Wait for kill
                await new Promise(r => setTimeout(r, 3000));

                // Try to pickup ONE hide after kill (don't loop)
                if (ctx.state()!.inventory.length < 26) {
                    const hides = ctx.sdk.getGroundItems()
                        .filter(i => /cow\s*hide/i.test(i.name))
                        .filter(i => i.distance <= 5)
                        .slice(0, 1);
                    if (hides.length > 0) {
                        const result = await ctx.bot.pickupItem(hides[0]!);
                        if (result.success) {
                            stats.hidesCollected++;
                        }
                    }
                }
                continue;
            }
        }

        // Wait for combat
        await new Promise(r => setTimeout(r, 800));
        markProgress(ctx, stats);
    }
}

function logFinalStats(ctx: ScriptContext, stats: Stats): void {
    const duration = (Date.now() - stats.startTime) / 1000;
    const atk = getAttackLevel(ctx);
    const str = getStrengthLevel(ctx);
    const def = getDefenceLevel(ctx);
    const coins = getCoins(ctx);
    const totalLevel = getTotalLevel(ctx);

    ctx.log('');
    ctx.log('=== Arc Results ===');
    ctx.log(`Duration: ${Math.round(duration)}s`);
    ctx.log(`Kills: ${stats.kills}`);
    ctx.log(`Hides collected: ${stats.hidesCollected}`);
    ctx.log(`Hides dropped: ${stats.hidesDropped}`);
    ctx.log(`Coins: ${coins}`);
    ctx.log(`Attack: ${atk}, Strength: ${str}, Defence: ${def}`);
    ctx.log(`Total Level: ${totalLevel}`);
    ctx.log('');
}

runArc({
    characterName: 'Adam_4',
    arcName: 'cowhide-training',
    goal: 'Kill cows, collect cowhides',
    timeLimit: 5 * 60 * 1000,
    stallTimeout: 60_000,
    screenshotInterval: 30_000,
    // Use existing save (don't reset!)
}, async (ctx) => {
    const stats: Stats = {
        kills: 0,
        hidesCollected: 0,
        hidesDropped: 0,
        coinsCollected: 0,
        startTime: Date.now(),
        lastProgressTime: Date.now(),
    };

    ctx.log('=== Arc: cowhide-training (Adam_4) ===');
    ctx.log(`Position: (${ctx.state()?.player?.worldX}, ${ctx.state()?.player?.worldZ})`);

    // Equip any available weapon
    const weapon = ctx.sdk.getInventory().find(i => /sword|scimitar|dagger/i.test(i.name));
    if (weapon) {
        const wieldOpt = weapon.optionsWithIndex.find(o => /wield|wear/i.test(o.text));
        if (wieldOpt) {
            ctx.log(`Equipping ${weapon.name}...`);
            await ctx.sdk.sendUseItem(weapon.slot, wieldOpt.opIndex);
            markProgress(ctx, stats);
        }
    }

    // Dismiss startup dialogs
    await ctx.bot.dismissBlockingUI();
    markProgress(ctx, stats);

    // Walk to cow field if not already there
    const player = ctx.state()?.player;
    if (player) {
        const dist = Math.sqrt(
            Math.pow(player.worldX - COW_FIELD.x, 2) +
            Math.pow(player.worldZ - COW_FIELD.z, 2)
        );
        if (dist > 20) {
            ctx.log('Walking to cow field...');
            await ctx.bot.walkTo(COW_FIELD.x, COW_FIELD.z);
            markProgress(ctx, stats);
        }
    }

    try {
        await cowLoop(ctx, stats);
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
