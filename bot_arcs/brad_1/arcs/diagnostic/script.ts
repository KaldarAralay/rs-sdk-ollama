/**
 * Arc: diagnostic
 * Character: Brad_1
 *
 * Goal: Check current state and report
 */

import { runArc } from '../../../arc-runner.ts';

runArc({
    characterName: 'brad_1',
    arcName: 'diagnostic',
    goal: 'Check current state',
    timeLimit: 60_000,
    stallTimeout: 30_000,
    launchOptions: {
        useSharedBrowser: false,
    },
}, async (ctx) => {
    ctx.log('=== Diagnostic Run ===');

    // Wait for state
    ctx.log('Waiting for state to populate...');
    try {
        await ctx.sdk.waitForCondition(s => {
            return !!(s.player && s.player.worldX > 0 && s.skills.some(sk => sk.baseLevel > 0));
        }, 45000);
    } catch (e) {
        ctx.error('State did not populate');
        return;
    }

    await new Promise(r => setTimeout(r, 2000));
    const state = ctx.state();

    ctx.log('');
    ctx.log('=== Current State ===');
    ctx.log(`Position: (${state?.player?.worldX}, ${state?.player?.worldZ})`);

    const atk = state?.skills.find(s => s.name === 'Attack');
    const str = state?.skills.find(s => s.name === 'Strength');
    const def = state?.skills.find(s => s.name === 'Defence');
    const hp = state?.skills.find(s => s.name === 'Hitpoints');
    const wc = state?.skills.find(s => s.name === 'Woodcutting');
    const mining = state?.skills.find(s => s.name === 'Mining');
    const fishing = state?.skills.find(s => s.name === 'Fishing');
    const thieving = state?.skills.find(s => s.name === 'Thieving');
    ctx.log(`Attack: ${atk?.baseLevel}`);
    ctx.log(`Strength: ${str?.baseLevel}`);
    ctx.log(`Defence: ${def?.baseLevel}`);
    ctx.log(`Hitpoints: ${hp?.level} / ${hp?.baseLevel}`);
    ctx.log(`Woodcutting: ${wc?.baseLevel}`);
    ctx.log(`Mining: ${mining?.baseLevel}`);
    ctx.log(`Fishing: ${fishing?.baseLevel}`);
    ctx.log(`Thieving: ${thieving?.baseLevel}`);

    const totalLevel = state?.skills.reduce((sum, s) => sum + s.baseLevel, 0) ?? 0;
    ctx.log(`Total Level: ${totalLevel}`);

    ctx.log('');
    ctx.log(`Inventory (${state?.inventory.length}/28):`);
    const grouped: Record<string, number> = {};
    for (const item of state?.inventory ?? []) {
        grouped[item.name] = (grouped[item.name] || 0) + (item.count || 1);
    }
    for (const [name, count] of Object.entries(grouped)) {
        ctx.log(`  ${count}x ${name}`);
    }

    ctx.log('');
    ctx.log('Equipment:');
    for (const equip of state?.equipment.filter(e => e) ?? []) {
        ctx.log(`  ${equip?.name}`);
    }

    ctx.log('');
    ctx.log('Nearby NPCs:');
    for (const npc of state?.nearbyNpcs.slice(0, 10) ?? []) {
        ctx.log(`  ${npc.name} (dist: ${npc.distance.toFixed(0)}, combat: ${npc.inCombat})`);
    }

    ctx.log('');
    ctx.log('Nearby Locations:');
    for (const loc of state?.nearbyLocs.slice(0, 10) ?? []) {
        ctx.log(`  ${loc.name} (dist: ${loc.distance.toFixed(0)})`);
    }

    ctx.log('');
    ctx.log('=== End Diagnostic ===');
});
