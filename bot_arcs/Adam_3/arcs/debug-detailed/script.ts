/**
 * Debug: Detailed state inspection for Adam_3
 */

import { runArc } from '../../../arc-runner';
import type { ScriptContext } from '../../../arc-runner';

runArc({
    characterName: 'Adam_3',
    arcName: 'debug-detailed',
    goal: 'Detailed state debug',
    timeLimit: 60 * 1000,  // 60 seconds
    stallTimeout: 45_000,
    screenshotInterval: 15_000,
}, async (ctx) => {
    const state = ctx.state();
    const sdk = ctx.sdk;

    ctx.log('=== DETAILED STATE DEBUG ===');

    // Player info
    ctx.log(`\nPlayer:`);
    ctx.log(`  Position: (${state?.player?.worldX}, ${state?.player?.worldZ})`);
    ctx.log(`  Level: ${state?.player?.combatLevel}`);
    ctx.log(`  animId: ${state?.player?.animId} (animating: ${(state?.player?.animId ?? -1) !== -1})`);
    ctx.log(`  inCombat: ${state?.player?.combat?.inCombat}`);

    // Full skills list
    ctx.log(`\nAll Skills:`);
    for (const skill of state?.skills ?? []) {
        ctx.log(`  ${skill.name}: Lvl ${skill.baseLevel}, XP ${skill.experience}`);
    }

    // Combat style info
    const combatStyle = state?.combatStyle;
    ctx.log(`\nCombat Style:`);
    ctx.log(`  Current: ${JSON.stringify(combatStyle)}`);

    // Equipment info (if available)
    ctx.log(`\nEquipment Slots:`);
    const equipment = (state as any)?.equipment ?? [];
    if (equipment.length > 0) {
        for (const item of equipment) {
            ctx.log(`  ${JSON.stringify(item)}`);
        }
    } else {
        ctx.log(`  (no equipment data)`);
    }

    // Try to attack a chicken and observe what happens
    ctx.log(`\nAttempting attack test...`);

    // First, walk to middle of chicken area
    ctx.log(`  Walking to chicken area first...`);
    await ctx.bot.walkTo(3196, 3356);
    await new Promise(r => setTimeout(r, 2000));

    const chicken = ctx.state()?.nearbyNpcs.find(n => /chicken/i.test(n.name));
    if (chicken) {
        ctx.log(`  Found chicken: index=${chicken.index}, dist=${chicken.distance}`);
        ctx.log(`  ALL options: ${JSON.stringify(chicken.options)}`);
        ctx.log(`  ALL optionsWithIndex: ${JSON.stringify(chicken.optionsWithIndex)}`);

        const attackOpt = chicken.optionsWithIndex.find(o => /attack/i.test(o.text));
        if (attackOpt) {
            ctx.log(`  Using Attack option: opIndex=${attackOpt.opIndex}`);

            const beforeHP = sdk.getSkill('Hitpoints');
            ctx.log(`  Before - HP: ${beforeHP?.experience} xp`);
            ctx.log(`  Attack XP: ${sdk.getSkill('Attack')?.experience}`);

            await sdk.sendInteractNpc(chicken.index, attackOpt.opIndex);
            ctx.log(`  Attack command sent`);

            // Wait longer for combat to happen
            ctx.log(`  Waiting 15s for combat...`);
            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 1000));
                ctx.progress();
            }

            const afterHP = sdk.getSkill('Hitpoints');
            ctx.log(`  After 5s - HP: ${afterHP?.experience} xp`);
            ctx.log(`  XP change: ${(afterHP?.experience ?? 0) - (beforeHP?.experience ?? 0)}`);

            const animId = ctx.state()?.player?.animId;
            ctx.log(`  animId: ${animId} (animating: ${(animId ?? -1) !== -1})`);

            // Also try with opIndex 0 directly
            ctx.log(`\n  Trying opIndex=0 directly...`);
            const chicken2 = ctx.state()?.nearbyNpcs.find(n => /chicken/i.test(n.name));
            if (chicken2) {
                const beforeHP2 = sdk.getSkill('Hitpoints');
                ctx.log(`  Before - HP: ${beforeHP2?.experience} xp`);
                await sdk.sendInteractNpc(chicken2.index, 0);
                ctx.log(`  Attack command sent with opIndex=0`);
                await new Promise(r => setTimeout(r, 5000));
                const afterHP2 = sdk.getSkill('Hitpoints');
                ctx.log(`  After 5s - HP: ${afterHP2?.experience} xp`);
                ctx.log(`  XP change: ${(afterHP2?.experience ?? 0) - (beforeHP2?.experience ?? 0)}`);
            }
        } else {
            ctx.log(`  No attack option on chicken`);
        }
    } else {
        ctx.log(`  No chicken found`);
    }

    ctx.progress();
    ctx.log(`\n=== DEBUG COMPLETE ===`);
});
