/**
 * Arc: money-grind
 * Character: Adam_4
 *
 * Goal: Make money by pickpocketing men/women in Lumbridge.
 * Strategy:
 * 1. Find men/women NPCs near Lumbridge castle
 * 2. Pickpocket them for 3 GP each
 * 3. Bank when GP >= 200
 * 4. Repeat until 2000+ GP banked
 *
 * Duration: 15 minutes
 */

import { runArc, StallError } from '../../../arc-runner.ts';
import type { ScriptContext } from '../../../arc-runner.ts';
import type { NearbyNpc } from '../../../../agent/types.ts';

// === LOCATIONS ===
const LOCATIONS = {
    LUMBRIDGE_CASTLE: { x: 3222, z: 3218 },
    DRAYNOR_BANK: { x: 3092, z: 3243 },
    COW_FIELD: { x: 3253, z: 3255 },
};

// Waypoints from cow field to Lumbridge Castle
// The cow field has fences - need to exit via NORTH then go around
// Character at (3253, 3255) needs to go north first, then west and south to Lumbridge
const WAYPOINTS_TO_CASTLE = [
    { x: 3253, z: 3275 },  // North inside cow field
    { x: 3253, z: 3290 },  // North exit area
    { x: 3240, z: 3295 },  // West from north exit
    { x: 3225, z: 3280 },  // Southwest
    { x: 3222, z: 3250 },  // Continue south
    { x: 3222, z: 3218 },  // Lumbridge Castle
];

// Waypoints from Lumbridge to Draynor Bank
const WAYPOINTS_TO_BANK = [
    { x: 3200, z: 3230 },  // West from Lumbridge
    { x: 3170, z: 3240 },  // Continue west
    { x: 3140, z: 3245 },  // Towards Draynor
    { x: 3110, z: 3243 },  // Near Draynor
    { x: 3092, z: 3243 },  // Draynor Bank
];

const WAYPOINTS_FROM_BANK = [
    { x: 3110, z: 3243 },  // East from Draynor
    { x: 3140, z: 3245 },  // Continue east
    { x: 3170, z: 3240 },  // Past swamp
    { x: 3200, z: 3230 },  // Near Lumbridge
    { x: 3222, z: 3218 },  // Lumbridge Castle
];

// === STATS ===
interface Stats {
    pickpockets: number;
    gpEarned: number;
    gpBanked: number;
    bankTrips: number;
    stunned: number;
    startTime: number;
}

function markProgress(ctx: ScriptContext): void {
    ctx.progress();
}

function getSkillLevel(ctx: ScriptContext, name: string): number {
    return ctx.state()?.skills.find(s => s.name === name)?.baseLevel ?? 1;
}

function getHP(ctx: ScriptContext): { current: number; max: number } {
    const hp = ctx.state()?.skills.find(s => s.name === 'Hitpoints');
    return { current: hp?.level ?? 10, max: hp?.baseLevel ?? 10 };
}

function getCoins(ctx: ScriptContext): number {
    const coins = ctx.state()?.inventory.find(i => /coins/i.test(i.name));
    return coins?.count ?? 0;
}

function getTotalLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.reduce((sum, s) => sum + s.baseLevel, 0) ?? 0;
}

// === WALKING ===
async function walkWaypoints(ctx: ScriptContext, waypoints: {x: number, z: number}[]): Promise<boolean> {
    for (let wpIdx = 0; wpIdx < waypoints.length; wpIdx++) {
        const wp = waypoints[wpIdx]!;
        ctx.log(`Walking to waypoint ${wpIdx + 1}/${waypoints.length}: (${wp.x}, ${wp.z})`);

        // Dismiss dialogs first
        if (ctx.state()?.dialog?.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            await new Promise(r => setTimeout(r, 300));
        }

        const result = await ctx.bot.walkTo(wp.x, wp.z);
        markProgress(ctx);

        if (!result.success) {
            ctx.warn(`Walk failed: ${result.message}`);
            // Try opening a gate/door
            const gateResult = await ctx.bot.openDoor(/gate|door/i);
            ctx.log(`Gate open result: ${gateResult.success ? 'opened' : gateResult.reason}`);
            await new Promise(r => setTimeout(r, 500));

            // Try direct sendWalk as fallback (might work for nearby destinations)
            ctx.log(`Trying direct walk to (${wp.x}, ${wp.z})`);
            await ctx.sdk.sendWalk(wp.x, wp.z, true);
            await new Promise(r => setTimeout(r, 3000));
            markProgress(ctx);
        }
    }
    return true;
}

// Simple walk using just sendWalk (for shorter distances)
async function simpleWalkTo(ctx: ScriptContext, x: number, z: number): Promise<void> {
    ctx.log(`Simple walk to (${x}, ${z})`);
    await ctx.sdk.sendWalk(x, z, true);
    await new Promise(r => setTimeout(r, 3000));
    markProgress(ctx);
}

// === BANKING ===
async function bankCoins(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    ctx.log('=== Banking GP at Draynor Bank ===');
    stats.bankTrips++;

    const gpBefore = getCoins(ctx);
    if (gpBefore < 200) {
        ctx.log(`Only ${gpBefore} GP, not enough to bank yet`);
        return false;
    }

    // Walk to bank
    ctx.log('Walking to Draynor Bank...');
    await walkWaypoints(ctx, WAYPOINTS_TO_BANK);

    // Open bank
    const banker = ctx.state()?.nearbyNpcs.find(n => /banker/i.test(n.name));
    if (!banker) {
        ctx.warn('No banker found!');
        return false;
    }

    const bankOpt = banker.optionsWithIndex?.find(o => /bank/i.test(o.text));
    if (!bankOpt) {
        ctx.warn('No bank option on banker');
        return false;
    }

    await ctx.sdk.sendInteractNpc(banker.index, bankOpt.opIndex);

    // Wait for bank to open
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 400));
        if (ctx.state()?.interface?.isOpen) {
            ctx.log('Bank opened!');
            break;
        }
        markProgress(ctx);
    }

    if (!ctx.state()?.interface?.isOpen) {
        ctx.warn('Bank did not open');
        return false;
    }

    // Deposit coins
    const coins = ctx.state()?.inventory.find(i => /coins/i.test(i.name));
    if (coins) {
        await ctx.sdk.sendBankDeposit(coins.slot, coins.count ?? 1);
        await new Promise(r => setTimeout(r, 500));
        markProgress(ctx);
    }

    await ctx.bot.closeShop();

    const gpAfter = getCoins(ctx);
    const banked = gpBefore - gpAfter;
    stats.gpBanked += banked;

    ctx.log(`Banked ${banked} GP (total banked this session: ${stats.gpBanked})`);

    // Return to Lumbridge
    ctx.log('Returning to Lumbridge...');
    await walkWaypoints(ctx, WAYPOINTS_FROM_BANK);

    return true;
}

// === THIEVING ===
function findTarget(ctx: ScriptContext, logDebug = false): NearbyNpc | null {
    const state = ctx.state();
    if (!state) return null;

    // Find men or women NPCs with pickpocket option
    const allNpcs = state.nearbyNpcs;
    const menWomen = allNpcs.filter(npc => /^(man|woman)$/i.test(npc.name));
    const withPickpocket = menWomen.filter(npc => npc.options.some(opt => /pickpocket/i.test(opt)));
    const notInCombat = withPickpocket.filter(npc => !npc.inCombat);
    const targets = notInCombat.sort((a, b) => a.distance - b.distance);

    if (logDebug && targets.length === 0) {
        ctx.log(`DEBUG: ${allNpcs.length} NPCs nearby, ${menWomen.length} men/women, ${withPickpocket.length} with pickpocket, ${notInCombat.length} not in combat`);
        if (allNpcs.length > 0) {
            const sample = allNpcs.slice(0, 5).map(n => `${n.name}(${n.distance.toFixed(0)})`).join(', ');
            ctx.log(`Nearby NPCs: ${sample}`);
        }
    }

    return targets[0] ?? null;
}

async function pickpocket(ctx: ScriptContext, target: NearbyNpc, stats: Stats): Promise<boolean> {
    const gpBefore = getCoins(ctx);

    const pickpocketOpt = target.optionsWithIndex.find(o => /pickpocket/i.test(o.text));
    if (!pickpocketOpt) {
        ctx.warn('No pickpocket option');
        return false;
    }

    await ctx.sdk.sendInteractNpc(target.index, pickpocketOpt.opIndex);
    await new Promise(r => setTimeout(r, 1500));  // Wait for action
    markProgress(ctx);

    // Check result
    const gpAfter = getCoins(ctx);
    const gained = gpAfter - gpBefore;

    if (gained > 0) {
        stats.pickpockets++;
        stats.gpEarned += gained;
        ctx.log(`Pickpocket success! +${gained} GP (total: ${gpAfter} GP)`);
        return true;
    }

    // Check if stunned
    const messages = ctx.state()?.gameMessages ?? [];
    const recentMsg = messages.slice(-3).map(m => m.text).join(' ');
    if (/stun|caught/i.test(recentMsg)) {
        stats.stunned++;
        ctx.log('Stunned! Waiting...');
        await new Promise(r => setTimeout(r, 5000));  // Stun lasts ~5 seconds
    }

    return false;
}

// === MAIN LOOP ===
async function mainLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    let loopCount = 0;
    let noTargetCount = 0;

    const BANK_THRESHOLD = 400;  // Bank less frequently to reduce walking time

    while (true) {
        loopCount++;
        const currentState = ctx.state();
        if (!currentState) break;

        // Periodic status
        if (loopCount % 20 === 0) {
            const thieving = getSkillLevel(ctx, 'Thieving');
            const hp = getHP(ctx);
            const gp = getCoins(ctx);
            ctx.log(`Loop ${loopCount}: Thieving ${thieving} | HP: ${hp.current}/${hp.max} | GP: ${gp} | Pickpockets: ${stats.pickpockets} | Banked: ${stats.gpBanked}`);
        }

        // Dismiss dialogs
        if (currentState.dialog.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            markProgress(ctx);
            await new Promise(r => setTimeout(r, 300));
            continue;
        }

        // Check if we should bank GP
        const gp = getCoins(ctx);
        if (gp >= BANK_THRESHOLD) {
            ctx.log(`Have ${gp} GP - banking!`);
            await bankCoins(ctx, stats);
            continue;
        }

        // Find target (with debug logging periodically)
        const shouldDebug = noTargetCount > 0 && noTargetCount % 5 === 0;
        const target = findTarget(ctx, shouldDebug);
        if (!target) {
            noTargetCount++;
            if (noTargetCount % 5 === 0) {
                const player = currentState.player;
                const distToCastle = player ? Math.sqrt(
                    Math.pow(player.worldX - LOCATIONS.LUMBRIDGE_CASTLE.x, 2) +
                    Math.pow(player.worldZ - LOCATIONS.LUMBRIDGE_CASTLE.z, 2)
                ) : 999;

                ctx.log(`No targets found at (${player?.worldX}, ${player?.worldZ}), dist to castle: ${distToCastle.toFixed(0)}`);

                if (distToCastle > 20) {
                    // Try to open any gate/door in the way first
                    ctx.log('Checking for gates/doors...');
                    await ctx.bot.openDoor(/gate|door/i);
                    await new Promise(r => setTimeout(r, 500));

                    ctx.log('Walking to Lumbridge castle via waypoints...');
                    await walkWaypoints(ctx, WAYPOINTS_TO_CASTLE);
                }
                markProgress(ctx);
            }
            await new Promise(r => setTimeout(r, 500));
            markProgress(ctx);
            continue;
        }

        noTargetCount = 0;

        // Check if idle
        const player = currentState.player;
        const isIdle = player?.animId === -1;

        if (isIdle) {
            await pickpocket(ctx, target, stats);
        }

        await new Promise(r => setTimeout(r, 600));
        markProgress(ctx);
    }
}

// === RUN THE ARC ===
runArc({
    characterName: 'Adam_4',
    arcName: 'money-grind',
    goal: 'Pickpocket men/women for GP, bank when 200+ GP',
    timeLimit: 15 * 60 * 1000,  // 15 minutes
    stallTimeout: 90_000,
    screenshotInterval: 30_000,
    launchOptions: {
        useSharedBrowser: false,
    },
}, async (ctx) => {
    const stats: Stats = {
        pickpockets: 0,
        gpEarned: 0,
        gpBanked: 0,
        bankTrips: 0,
        stunned: 0,
        startTime: Date.now(),
    };

    ctx.log('=== Arc: money-grind (THIEVING) ===');
    ctx.log('Goal: Pickpocket men/women for GP, bank when 200+ GP');
    ctx.log('Target: 2000+ GP in bank');

    // Wait for state
    ctx.log('Waiting for state...');
    try {
        await ctx.sdk.waitForCondition(s => {
            return !!(s.player && s.player.worldX > 0 && s.skills.some(skill => skill.baseLevel > 0));
        }, 30000);
    } catch (e) {
        ctx.error('State did not populate');
        return;
    }
    await new Promise(r => setTimeout(r, 500));

    const state = ctx.state();
    if (!state?.player || state.player.worldX === 0) {
        ctx.error('Invalid state');
        return;
    }

    ctx.log('Position: (' + state.player.worldX + ', ' + state.player.worldZ + ')');
    ctx.log('Thieving level: ' + getSkillLevel(ctx, 'Thieving'));
    ctx.log('Total Level: ' + getTotalLevel(ctx));
    ctx.log('GP: ' + getCoins(ctx));

    // Dismiss dialogs
    await ctx.bot.dismissBlockingUI();
    markProgress(ctx);

    // Walk to Lumbridge if far away
    const player = ctx.state()?.player;
    const distToLumbridge = player ? Math.sqrt(
        Math.pow(player.worldX - LOCATIONS.LUMBRIDGE_CASTLE.x, 2) +
        Math.pow(player.worldZ - LOCATIONS.LUMBRIDGE_CASTLE.z, 2)
    ) : 999;

    if (distToLumbridge > 50) {
        ctx.log(`Not near Lumbridge (${Math.round(distToLumbridge)} tiles away), walking there...`);
        await ctx.bot.walkTo(LOCATIONS.LUMBRIDGE_CASTLE.x, LOCATIONS.LUMBRIDGE_CASTLE.z);
    }

    // Main loop
    try {
        await mainLoop(ctx, stats);
    } catch (e) {
        if (e instanceof StallError) {
            ctx.error('Arc stalled: ' + e.message);
        } else {
            throw e;
        }
    }

    // Final stats
    const duration = (Date.now() - stats.startTime) / 1000;
    ctx.log('');
    ctx.log('=== Final Stats ===');
    ctx.log('Duration: ' + Math.round(duration) + 's');
    ctx.log('Pickpockets: ' + stats.pickpockets);
    ctx.log('GP earned: ' + stats.gpEarned);
    ctx.log('GP banked this session: ' + stats.gpBanked);
    ctx.log('Bank trips: ' + stats.bankTrips);
    ctx.log('Times stunned: ' + stats.stunned);
    ctx.log('Thieving level: ' + getSkillLevel(ctx, 'Thieving'));
    ctx.log('Total Level: ' + getTotalLevel(ctx));
    ctx.log('Final GP in inventory: ' + getCoins(ctx));
});
