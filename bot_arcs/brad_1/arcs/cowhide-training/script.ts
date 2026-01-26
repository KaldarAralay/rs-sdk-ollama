/**
 * Arc: cowhide-training
 * Character: Brad_1
 *
 * Goal: Train combat while collecting cowhides, then bank at Varrock West Bank.
 * Strategy:
 * - Kill cows and loot cowhides
 * - When inventory has 25+ hides, walk to Varrock West Bank (3185, 3436)
 * - CRITICAL: Open gate with ctx.bot.openDoor(/gate/i) BEFORE walking through
 * - Deposit hides, return to cows
 * - Cycle combat styles for balanced training
 *
 * Duration: 10 minutes
 */

import { runArc, StallError } from '../../../arc-runner';
import type { ScriptContext } from '../../../arc-runner';
import type { NearbyNpc } from '../../../../agent/types';

// === LOCATIONS ===
const LOCATIONS = {
    COW_FIELD: { x: 3253, z: 3279 },
    VARROCK_WEST_BANK: { x: 3185, z: 3436 },
};

// The cow pen has a gate on the south side around (3253, 3267)
// Inside pen: z between 3267-3295
// Gate position: (3253, 3267)

// Waypoints from cow field to Varrock West Bank (PROVEN ROUTE from Run 16)
// Exit via south gate, walk north along road
const WAYPOINTS_TO_BANK = [
    { x: 3250, z: 3290 },  // Inside pen near gate
    { x: 3250, z: 3260 },  // Just outside south gate
    { x: 3245, z: 3300 },  // North on road
    { x: 3235, z: 3340 },  // Continue north
    { x: 3220, z: 3380 },  // Continue north
    { x: 3200, z: 3420 },  // Approaching bank
    { x: 3185, z: 3436 },  // Varrock West Bank
];

const WAYPOINTS_TO_COWS = [
    { x: 3200, z: 3420 },  // South from bank
    { x: 3220, z: 3380 },  // Continue south
    { x: 3235, z: 3340 },  // Continue south
    { x: 3245, z: 3300 },  // Continue south
    { x: 3250, z: 3265 },  // Near cow field south gate
];

// === COMBAT STYLES ===
const COMBAT_STYLES = {
    ACCURATE: 0,    // Trains Attack
    AGGRESSIVE: 1,  // Trains Strength
    DEFENSIVE: 3,   // Trains Defence
};

// Style rotation: 2 Attack, 1 Strength, 2 Defence (focus on catching up Defence)
const STYLE_ROTATION = [
    { style: COMBAT_STYLES.ACCURATE, name: 'Accurate (Attack)' },
    { style: COMBAT_STYLES.ACCURATE, name: 'Accurate (Attack)' },
    { style: COMBAT_STYLES.AGGRESSIVE, name: 'Aggressive (Strength)' },
    { style: COMBAT_STYLES.DEFENSIVE, name: 'Defensive (Defence)' },
    { style: COMBAT_STYLES.DEFENSIVE, name: 'Defensive (Defence)' },
];

let lastStyleChange = 0;
let currentStyleIndex = 0;
let lastSetStyle = -1;
const STYLE_CYCLE_MS = 25_000;  // 25 seconds per style

// === STATS ===
interface Stats {
    kills: number;
    hidesLooted: number;
    hidesBanked: number;
    bankTrips: number;
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

function countHides(ctx: ScriptContext): number {
    const inv = ctx.state()?.inventory ?? [];
    return inv.filter(i => /cow\s*hide/i.test(i.name)).length;
}

function getInventorySpace(ctx: ScriptContext): number {
    return 28 - (ctx.state()?.inventory?.length ?? 0);
}

// === WALKING ===
// Use sendWalk directly for more reliable walking (shorter steps)
async function walkToPoint(ctx: ScriptContext, targetX: number, targetZ: number): Promise<boolean> {
    const startPlayer = ctx.state()?.player;
    if (!startPlayer) return false;

    const startDist = Math.sqrt(
        Math.pow(startPlayer.worldX - targetX, 2) +
        Math.pow(startPlayer.worldZ - targetZ, 2)
    );

    // If already close, we're done
    if (startDist < 10) return true;

    // Send walk command
    await ctx.sdk.sendWalk(targetX, targetZ, true);
    markProgress(ctx);

    // Wait to arrive (up to 15 seconds for short distances)
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        markProgress(ctx);

        // Dismiss dialogs
        if (ctx.state()?.dialog?.isOpen) {
            await ctx.sdk.sendClickDialog(0);
        }

        const currentPlayer = ctx.state()?.player;
        if (currentPlayer) {
            const dist = Math.sqrt(
                Math.pow(currentPlayer.worldX - targetX, 2) +
                Math.pow(currentPlayer.worldZ - targetZ, 2)
            );
            if (dist < 10) {
                return true;  // Arrived
            }

            // Re-send walk every 5 seconds
            if (i % 10 === 9) {
                await ctx.sdk.sendWalk(targetX, targetZ, true);
            }
        }
    }

    return false;
}

async function walkWaypoints(ctx: ScriptContext, waypoints: {x: number, z: number}[], label: string): Promise<boolean> {
    ctx.log(`Walking ${label} via ${waypoints.length} waypoints...`);

    for (let wpIdx = 0; wpIdx < waypoints.length; wpIdx++) {
        const wp = waypoints[wpIdx]!;
        const player = ctx.state()?.player;
        const startPos = player ? `(${player.worldX}, ${player.worldZ})` : '(unknown)';
        ctx.log(`  Waypoint ${wpIdx + 1}/${waypoints.length}: ${startPos} -> (${wp.x}, ${wp.z})`);

        const arrived = await walkToPoint(ctx, wp.x, wp.z);
        if (arrived) {
            const currentPlayer = ctx.state()?.player;
            ctx.log(`  Arrived at waypoint ${wpIdx + 1} (at ${currentPlayer?.worldX}, ${currentPlayer?.worldZ})`);
        } else {
            const finalPlayer = ctx.state()?.player;
            ctx.log(`  Failed to reach waypoint ${wpIdx + 1}, at (${finalPlayer?.worldX}, ${finalPlayer?.worldZ})`);
        }
    }

    const finalPos = ctx.state()?.player;
    ctx.log(`Walk complete. Now at (${finalPos?.worldX}, ${finalPos?.worldZ})`);
    return true;
}

// Helper to check if inside or near enough to cow pen (can attack cows)
function isInsideCowPen(ctx: ScriptContext): boolean {
    const player = ctx.state()?.player;
    if (!player) return false;
    // Expanded cow pen area - includes some buffer around the actual pen
    // The key is: can we attack cows without "I can't reach that!" messages
    // Pen is roughly: x between 3240-3270, z between 3255-3295
    return player.worldX >= 3235 && player.worldX <= 3270 &&
           player.worldZ >= 3255 && player.worldZ <= 3295;
}

// Check if stuck outside cow pen on north side (can't walk through fence)
function isOutsideOnNorth(ctx: ScriptContext): boolean {
    const player = ctx.state()?.player;
    if (!player) return false;
    // North of fence: z > 3295 (roughly) and within x range of pen
    return player.worldZ > 3295 && player.worldX >= 3235 && player.worldX <= 3270;
}

// Walk around fence from north side to south gate and enter pen
async function enterCowPenFromNorth(ctx: ScriptContext): Promise<boolean> {
    ctx.log('Entering cow pen from north - walking around fence to south gate...');

    // Walk east around the fence
    ctx.log('Step 1: Walking east to avoid fence...');
    await ctx.sdk.sendWalk(3270, 3295, true);
    await new Promise(r => setTimeout(r, 3000));
    markProgress(ctx);

    // Walk south along east side
    ctx.log('Step 2: Walking south along east side...');
    await ctx.sdk.sendWalk(3270, 3265, true);
    await new Promise(r => setTimeout(r, 3000));
    markProgress(ctx);

    // Walk west to south gate area
    ctx.log('Step 3: Walking west to south gate...');
    await ctx.sdk.sendWalk(3253, 3263, true);
    await new Promise(r => setTimeout(r, 3000));
    markProgress(ctx);

    // Open gate
    ctx.log('Step 4: Opening gate...');
    await ctx.bot.openDoor(/gate/i);
    await new Promise(r => setTimeout(r, 1500));
    markProgress(ctx);

    // Walk through gate into pen
    ctx.log('Step 5: Walking through gate...');
    await ctx.sdk.sendWalk(3253, 3275, true);
    await new Promise(r => setTimeout(r, 3000));
    markProgress(ctx);

    const finalPos = ctx.state()?.player;
    const inside = isInsideCowPen(ctx);
    ctx.log(`After entry: position (${finalPos?.worldX}, ${finalPos?.worldZ}), inside=${inside}`);

    return inside;
}

// === BANKING ===
async function bankHides(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    ctx.log('=== Banking Trip ===');
    stats.bankTrips++;

    const hidesBefore = countHides(ctx);
    ctx.log(`Hides to bank: ${hidesBefore}`);

    // Get current position
    const startPos = ctx.state()?.player;
    const startX = startPos?.worldX ?? 0;
    const startZ = startPos?.worldZ ?? 0;
    ctx.log(`Starting position: (${startX}, ${startZ})`);

    const insidePen = isInsideCowPen(ctx);
    ctx.log(`Inside cow pen: ${insidePen}`);

    // If not inside the pen, we need to first walk back to cow field
    if (!insidePen) {
        ctx.log('Not in cow pen! Walking back to cow field first...');
        // Walk to cow field area
        const arrivedNearCows = await walkToPoint(ctx, 3253, 3285);
        if (!arrivedNearCows) {
            ctx.warn('Could not reach cow field - banking failed');
            return false;
        }
    }

    // Now we should be in or near the cow pen - exit via SOUTH gate
    // Gate is at approximately (3253, 3267) - need to approach from inside (z > 3267)
    ctx.log('Walking to south gate area inside pen...');

    // First walk closer to gate (still inside pen)
    await ctx.sdk.sendWalk(3253, 3270, true);
    await new Promise(r => setTimeout(r, 2000));
    markProgress(ctx);

    const preGatePos = ctx.state()?.player;
    ctx.log(`Pre-gate position: (${preGatePos?.worldX}, ${preGatePos?.worldZ})`);

    // CRITICAL: Open the gate BEFORE trying to walk through
    ctx.log('Opening gate to exit cow pen...');
    await ctx.bot.openDoor(/gate/i);
    await new Promise(r => setTimeout(r, 1500));
    markProgress(ctx);

    // Walk THROUGH the open gate step by step (use direct sendWalk, not pathfinder)
    ctx.log('Walking through gate (step 1: to gate)...');
    await ctx.sdk.sendWalk(3253, 3267, true);
    await new Promise(r => setTimeout(r, 1500));
    markProgress(ctx);

    ctx.log('Walking through gate (step 2: through gate)...');
    await ctx.sdk.sendWalk(3253, 3263, true);
    await new Promise(r => setTimeout(r, 2000));
    markProgress(ctx);

    ctx.log('Walking through gate (step 3: away from gate)...');
    await ctx.sdk.sendWalk(3250, 3258, true);
    await new Promise(r => setTimeout(r, 2000));
    markProgress(ctx);

    const afterGatePos = ctx.state()?.player;
    const afterX = afterGatePos?.worldX ?? 0;
    const afterZ = afterGatePos?.worldZ ?? 0;
    ctx.log(`Position after exit: (${afterX}, ${afterZ})`);

    // Verify we actually exited - outside pen should have z < 3268 (gate is around 3267)
    // Being at z=3266 or lower is fine for exiting
    if (afterZ > 3268) {
        ctx.warn(`Failed to exit cow pen (at z=${afterZ}, expected z < 3268), aborting bank trip`);
        return false;
    }
    ctx.log('Successfully exited cow pen!');

    // Walk to Varrock West Bank (going north)
    await walkWaypoints(ctx, WAYPOINTS_TO_BANK, 'to Varrock West Bank');

    // Open bank
    ctx.log('Opening bank...');
    const banker = ctx.state()?.nearbyNpcs.find(n => /banker/i.test(n.name));
    if (!banker) {
        ctx.warn('No banker found!');
        const nearby = ctx.state()?.nearbyNpcs.slice(0, 5).map(n => n.name).join(', ');
        ctx.log('Nearby NPCs: ' + nearby);
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

    // Deposit all hides
    const hides = ctx.state()?.inventory.filter(i => /cow\s*hide/i.test(i.name)) ?? [];
    for (const hide of hides) {
        await ctx.sdk.sendBankDeposit(hide.slot, hide.count ?? 1);
        await new Promise(r => setTimeout(r, 150));
        markProgress(ctx);
    }

    // Also deposit raw beef and bones to clear space
    const junk = ctx.state()?.inventory.filter(i => /raw\s*beef|^bones$/i.test(i.name)) ?? [];
    for (const item of junk) {
        await ctx.sdk.sendBankDeposit(item.slot, item.count ?? 1);
        await new Promise(r => setTimeout(r, 150));
        markProgress(ctx);
    }

    await new Promise(r => setTimeout(r, 500));

    const hidesAfter = countHides(ctx);
    const deposited = hidesBefore - hidesAfter;
    stats.hidesBanked += deposited;
    ctx.log(`Deposited ${deposited} hides (total banked: ${stats.hidesBanked})`);

    // Close bank (walking away works too)
    await ctx.bot.closeShop();

    // Return to cow field via south route
    ctx.log('Returning to cow field...');
    await walkWaypoints(ctx, WAYPOINTS_TO_COWS, 'back to cow field');

    // Now at south side of cow field, near gate - OPEN GATE before walking through
    ctx.log('Opening cow field gate to enter...');
    await ctx.bot.openDoor(/gate/i);
    await new Promise(r => setTimeout(r, 1000));
    markProgress(ctx);

    // Walk THROUGH gate into cow field (from south)
    ctx.log('Walking through gate into cow pen...');
    await walkToPoint(ctx, 3253, 3275);  // Just inside south gate
    markProgress(ctx);

    // Walk to center of cow field
    ctx.log('Walking to cow field center...');
    await ctx.bot.walkTo(LOCATIONS.COW_FIELD.x, LOCATIONS.COW_FIELD.z);
    await new Promise(r => setTimeout(r, 1000));
    markProgress(ctx);

    const finalPos = ctx.state()?.player;
    ctx.log(`=== Back at cows: (${finalPos?.worldX}, ${finalPos?.worldZ}) ===`);
    return true;
}

// === COMBAT ===
function findCow(ctx: ScriptContext): NearbyNpc | null {
    const state = ctx.state();
    if (!state) return null;

    const cows = state.nearbyNpcs
        .filter(npc => /^cow$/i.test(npc.name))
        .filter(npc => npc.options.some(opt => /attack/i.test(opt)))
        .filter(npc => !npc.inCombat)
        .sort((a, b) => a.distance - b.distance);

    return cows[0] ?? null;
}

async function cycleCombatStyle(ctx: ScriptContext): Promise<void> {
    const now = Date.now();
    if (now - lastStyleChange >= STYLE_CYCLE_MS) {
        currentStyleIndex = (currentStyleIndex + 1) % STYLE_ROTATION.length;
        lastStyleChange = now;
    }

    const target = STYLE_ROTATION[currentStyleIndex]!;
    if (lastSetStyle !== target.style) {
        ctx.log('Combat style: ' + target.name);
        await ctx.sdk.sendSetCombatStyle(target.style);
        lastSetStyle = target.style;
    }
}

async function lootHide(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    const space = getInventorySpace(ctx);
    if (space <= 0) return false;

    const groundItems = ctx.sdk.getGroundItems();
    const hide = groundItems
        .filter(i => /cow\s*hide/i.test(i.name))
        .filter(i => i.distance <= 5)
        .sort((a, b) => a.distance - b.distance)[0];

    if (hide) {
        const result = await ctx.bot.pickupItem(hide);
        if (result.success) {
            stats.hidesLooted++;
            ctx.log(`Looted cowhide (${countHides(ctx)} in inv)`);
            markProgress(ctx);
            return true;
        }
    }
    return false;
}

async function eatFoodIfNeeded(ctx: ScriptContext): Promise<boolean> {
    const hp = getHP(ctx);
    if (hp.current >= hp.max * 0.5) return false;

    const food = ctx.state()?.inventory.find(i =>
        /cooked|bread|shrimp|trout|salmon|lobster|meat/i.test(i.name)
    );

    if (food) {
        const eatOpt = food.optionsWithIndex.find(o => /eat/i.test(o.text));
        if (eatOpt) {
            ctx.log('Eating ' + food.name);
            await ctx.sdk.sendUseItem(food.slot, eatOpt.opIndex);
            markProgress(ctx);
            return true;
        }
    }
    return false;
}

// === MAIN LOOP ===
async function trainingLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    lastStyleChange = Date.now();
    currentStyleIndex = 0;
    lastSetStyle = -1;
    let noCowCount = 0;
    let loopCount = 0;

    const BANK_THRESHOLD = 22;  // Bank when we have 22+ hides (allow room for tools/beef)

    while (true) {
        loopCount++;
        const currentState = ctx.state();
        if (!currentState) break;

        // Periodic status
        if (loopCount % 40 === 0) {
            const atk = getSkillLevel(ctx, 'Attack');
            const str = getSkillLevel(ctx, 'Strength');
            const def = getSkillLevel(ctx, 'Defence');
            const hp = getHP(ctx);
            const hides = countHides(ctx);
            ctx.log(`Loop ${loopCount}: Atk ${atk}, Str ${str}, Def ${def} | HP: ${hp.current}/${hp.max} | Kills: ${stats.kills} | Hides: ${hides}`);
        }

        // Dismiss dialogs
        if (currentState.dialog.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            markProgress(ctx);
            await new Promise(r => setTimeout(r, 300));
            continue;
        }

        // Check if stuck outside cow pen on north side (can't attack cows through fence)
        if (isOutsideOnNorth(ctx)) {
            ctx.log('Detected: stuck outside cow pen on north side!');
            const entered = await enterCowPenFromNorth(ctx);
            if (!entered) {
                ctx.warn('Failed to enter cow pen from north');
            }
            continue;
        }

        // Check if we should bank
        const hides = countHides(ctx);
        if (hides >= BANK_THRESHOLD) {
            ctx.log(`Inventory has ${hides} hides - time to bank!`);
            const bankSuccess = await bankHides(ctx, stats);
            if (!bankSuccess) {
                ctx.warn('Banking failed - will drop hides and continue training');
                // Drop hides to make room for more training
                const invHides = ctx.state()?.inventory.filter(i => /cow\s*hide/i.test(i.name)) ?? [];
                for (const hide of invHides.slice(0, 10)) {  // Drop up to 10
                    await ctx.sdk.sendDropItem(hide.slot);
                    await new Promise(r => setTimeout(r, 100));
                    markProgress(ctx);
                }
                ctx.log('Dropped some hides, continuing training...');
            }
            continue;
        }

        // Eat if needed
        await eatFoodIfNeeded(ctx);

        // Cycle combat style
        await cycleCombatStyle(ctx);

        // Try to loot nearby hides first
        const space = getInventorySpace(ctx);
        if (space > 0) {
            await lootHide(ctx, stats);
        }

        // Check if idle
        const player = currentState.player;
        const isIdle = player?.animId === -1;

        if (isIdle) {
            const cow = findCow(ctx);
            if (!cow) {
                noCowCount++;
                if (noCowCount % 20 === 0) {
                    ctx.log('No cows found, walking to field center...');
                    await ctx.sdk.sendWalk(LOCATIONS.COW_FIELD.x, LOCATIONS.COW_FIELD.z, true);
                    await new Promise(r => setTimeout(r, 2000));
                    markProgress(ctx);
                }
                await new Promise(r => setTimeout(r, 200));
                markProgress(ctx);
                continue;
            }

            noCowCount = 0;

            const attackResult = await ctx.bot.attackNpc(cow);
            if (attackResult.success) {
                stats.kills++;
                markProgress(ctx);
                await new Promise(r => setTimeout(r, 2000));
            } else {
                if (attackResult.reason === 'out_of_reach') {
                    await ctx.bot.openDoor(/gate/i);
                    markProgress(ctx);
                }
            }
        }

        await new Promise(r => setTimeout(r, 600));
        markProgress(ctx);
    }
}

// === RUN THE ARC ===
runArc({
    characterName: 'brad_1',
    arcName: 'cowhide-training',
    goal: 'Train combat, collect hides, bank at Varrock West',
    timeLimit: 10 * 60 * 1000,  // 10 minutes
    stallTimeout: 60_000,
    screenshotInterval: 30_000,
    launchOptions: {
        useSharedBrowser: false,
    },
}, async (ctx) => {
    const stats: Stats = {
        kills: 0,
        hidesLooted: 0,
        hidesBanked: 0,
        bankTrips: 0,
        startTime: Date.now(),
    };

    ctx.log('=== Arc: cowhide-training ===');
    ctx.log('Goal: Train combat + collect hides + bank at Varrock West');

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
    ctx.log('Stats: Attack ' + getSkillLevel(ctx, 'Attack') + ', Strength ' + getSkillLevel(ctx, 'Strength') + ', Defence ' + getSkillLevel(ctx, 'Defence'));
    ctx.log('Hides in inventory: ' + countHides(ctx));

    // Equip gear
    const inv = state.inventory;
    const equip = state.equipment;

    const hasWeapon = equip.some(e => e && /sword|axe|mace|dagger|scimitar/i.test(e.name));
    if (!hasWeapon) {
        const weapon = inv.find(i => /sword|mace|scimitar/i.test(i.name) && !/pickaxe/i.test(i.name));
        if (weapon) {
            ctx.log('Equipping ' + weapon.name);
            await ctx.bot.equipItem(weapon);
            markProgress(ctx);
        }
    }

    const shield = inv.find(i => /shield/i.test(i.name));
    if (shield) {
        ctx.log('Equipping ' + shield.name);
        await ctx.bot.equipItem(shield);
        markProgress(ctx);
    }

    // Dismiss dialogs
    await ctx.bot.dismissBlockingUI();
    markProgress(ctx);

    // Open gate if at cow field
    await ctx.bot.openDoor(/gate/i);
    await new Promise(r => setTimeout(r, 500));
    markProgress(ctx);

    // Main loop
    try {
        await trainingLoop(ctx, stats);
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
    ctx.log('Kills: ' + stats.kills);
    ctx.log('Hides looted: ' + stats.hidesLooted);
    ctx.log('Hides banked: ' + stats.hidesBanked);
    ctx.log('Bank trips: ' + stats.bankTrips);
    ctx.log('Attack: ' + getSkillLevel(ctx, 'Attack'));
    ctx.log('Strength: ' + getSkillLevel(ctx, 'Strength'));
    ctx.log('Defence: ' + getSkillLevel(ctx, 'Defence'));
    ctx.log('Total Level: ' + (ctx.state()?.skills.reduce((sum, s) => sum + s.baseLevel, 0) ?? 0));
});
