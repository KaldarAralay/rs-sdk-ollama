# Bot Agent Trajectory Analysis Report

**Date:** 2026-01-23
**Runs Analyzed:** 12
**Accounts:** gabe1, default, bkl7c9
**Total Events:** ~4,700
**Total Runtime:** ~4 hours

---

## Executive Summary

Analyzed 12 test runs with similar goals: "make money and acquire better armor" or "train combat skills, make money, upgrade armor."

**Overall Success Rate:** Partial - combat training generally succeeded, but money-making and armor acquisition largely failed.

---

## Accomplishments Across All Runs

### Combat Training (Most Successful)

| Account | Best Level Gains |
|---------|-----------------|
| gabe1 | Attack 10→21, Strength 26→47, Hitpoints 22→40, Combat 20→41 |
| default | Defence 31→37, Strength 28→47, Hitpoints 32→40 |
| bkl7c9 | Strength 1→26, Hitpoints 10→24, Combat 13→20 |

**Total enemies killed across all runs:** ~1,000+

### Money Earned (Mixed Results)

- **Best run**: 353 coins (gabe1, from random event casket)
- **Typical run**: 42 coins (starting inventory sold)
- **Worst runs**: 0 coins earned (several runs)
- **Single successful purchase**: Iron sword (91 coins) in one gabe1 run

### Items Acquired

- Random event rewards: Caskets, Kebab, Beer, Air runes, Mind runes
- Skill items: Logs, Ores, Herbs, Feathers
- Ground pickups: Coins, Bones, Berries

---

## Failure Pattern Analysis

### Category 1: Shop System Failures (CRITICAL)

**Occurrence:** Every single run
**Success Rate:** ~0%

**Symptoms:**
- `bot.openShop()` calls fail without clear errors
- NPC shopkeepers wander away during interaction
- Trade option doesn't work, Talk option doesn't lead to shop
- Selling interface doesn't respond

**Examples:**
```
"Peksa's shop isn't opening"
"The shop isn't opening properly. Let me try a different approach..."
"Tried to open Bob's shop - didn't work properly"
```

**Impact:** Agents couldn't buy armor even when they had coins (353 coins in one run, still no armor purchased).

---

### Category 2: Item Pickup Failures (HIGH IMPACT)

**Occurrence:** 10/12 runs
**Cycles Wasted:** 5-50+ per run

**Symptoms:**
- "I can't reach that!" message on ground items
- Items behind doors/walls unreachable
- Agent retries 7-15 times before giving up
- No pathfinding to accessible position

**Example - Iron Dagger Loop:**
```
Cycle 38: Saw Iron dagger on ground
Cycle 39: "I can't reach that!"
Cycle 40: Tried walking closer
Cycle 41: "I can't reach that!"
...
Cycle 88: Finally gave up (50 cycles wasted)
```

**Impact:** One run spent 60% of total time on a single unreachable item.

---

### Category 3: Navigation/Walking Issues (HIGH FREQUENCY)

**Occurrence:** 12/12 runs

| Issue | Frequency |
|-------|-----------|
| walkTo() timeouts | Every run |
| Stuck in same location | 8/12 runs |
| Walking in circles | 6/12 runs |
| Long-distance walks fail | 10/12 runs |

**Example - Immobilization:**
```
"Still slowly moving" → "still stuck in same area" →
"walking isn't working properly" (13+ cycles stuck)
```

**Root Causes:**
- Imprecise coordinates
- No arrival validation
- Obstacles blocking path
- Long distances not supported

---

### Category 4: Combat Loot Expectations (SYSTEMIC)

**Occurrence:** 12/12 runs
**Wasted Combat Cycles:** 200+ total across runs

**The Pattern:**
1. Agent kills 20+ enemies
2. Expects coin/armor drops
3. Gets nothing (or just bones)
4. Tries again with different enemy type
5. Still nothing
6. Eventually gives up or run ends

**Evidence:**
- gabe1 run: "Killed 15 cows, no loot appeared"
- default run: "Killed 10 guards... only have 42 coins still"
- bkl7c9 run: "killCount: 20, feathers: 0, rawChicken: 0"

**Root Cause:** Server appears to have drops disabled/restricted, but agent never adapts strategy.

---

### Category 5: Combat Style Confusion (TECHNICAL)

**Occurrence:** 4/12 runs (training-focused runs)

**Symptoms:**
- Set to "Aggressive" but Attack leveled instead of Strength
- Combat style indices don't match expected skills
- Agent confused why wrong skills are training

**Example:**
```
"Set combat style to 'Aggressive' for Strength training"
"Attack gained XP instead of Strength"
"Wasted 50+ kills with ineffective combat style"
```

---

### Category 6: Al-Kharid Gate Blockage (ENVIRONMENTAL)

**Occurrence:** 4/12 runs

**Symptoms:**
- Toll gate dialog opens but can't navigate
- Need 10 coins but don't have them
- Agent tries to walk through anyway
- Gets stuck in dialog loop

---

### Category 7: Strategy Thrashing (BEHAVIORAL)

**Occurrence:** 8/12 runs

**The Pattern:**
```
Try combat farming (fails) →
Try shop selling (fails) →
Try pickpocketing (fails) →
Try resource gathering (fails) →
Back to combat farming (fails again)
```

- Average strategies attempted per run: **5-7**
- Average strategies completed: **0-1**

---

### Category 8: Failure to Learn (META-COGNITIVE)

**Occurrence:** 12/12 runs

**Evidence:**
- Same shop interaction code tried in all 12 runs despite 0% success
- Same combat loop code despite consistent no-drop results
- Same item pickup retries despite "I can't reach that!"
- No cross-run learning or adaptation

---

## Inefficiency Metrics

| Metric | Average | Worst Case |
|--------|---------|------------|
| Cycles wasted on unreachable items | 12 per run | 50+ |
| Failed shop interaction attempts | 8 per run | 25+ |
| Combat kills with no drops | 50+ per run | 200+ |
| Strategy changes without completion | 5 per run | 7 |
| Frustration phrases detected | 18 per run | 27 |
| Walking timeout events | 6 per run | 13 |

**Overall Efficiency Estimate:**
- **Productive cycles:** ~35-40%
- **Wasted on failed mechanics:** ~40-50%
- **Wasted on strategy thrashing:** ~15-20%

---

## Cross-Account Comparison

| Account | Runs | Best Combat Gain | Best Money | Shop Success | Armor Acquired |
|---------|------|-----------------|------------|--------------|----------------|
| gabe1 | 5 | +27 Strength | 353 coins | 0% | Iron sword only |
| default | 3 | +17 Strength | 23 coins | 0% | None |
| bkl7c9 | 4 | +25 Strength | 42 coins | 0% | None |

---

## Recommendations

### Critical Fixes (P0)

1. **Fix shop interaction system** - 0% success rate is unacceptable
2. **Add NPC tracking/following** when shopkeepers wander
3. **Implement "I can't reach" detection** - abandon after 2-3 attempts

### High Priority (P1)

4. **Add drop rate monitoring** - if 20+ kills = 0 drops, pivot strategy
5. **Walk destination validation** - confirm arrival before proceeding
6. **Combat style verification** - check which skill actually gains XP

### Medium Priority (P2)

7. **Strategy persistence threshold** - require N attempts before switching
8. **Goal decomposition** - break "get armor" into atomic checkpointed steps
9. **World knowledge integration** - enemy loot tables, shop locations

### Low Priority (P3)

10. **Cross-run learning** - persist what works/doesn't work
11. **Efficiency tracking** - gold/XP per minute metrics
12. **Fallback strategy queue** - predefined alternatives when primary fails

---

## Conclusion

The agent demonstrates competence at **basic combat training** but fails at **economic activities** (shopping, selling, loot collection). The core issues are:

1. **Broken shop mechanics** preventing any armor purchases
2. **Pathfinding failures** causing massive time waste
3. **No adaptation** to server-specific conditions (disabled drops)
4. **Strategy thrashing** without completing any approach

The most successful runs were those that got lucky with **random events** (Mysterious Old Man casket providing coins) rather than executing intended strategies. Until shop interactions and item pickup are fixed, the agent cannot achieve its stated goals.

---

## Analyzed Runs

### gabe1 Account

| Run | Duration | Events | Goal |
|-----|----------|--------|------|
| [2026-01-23T20-36-15](./2026-01-23T20-36-15-gabe1-make-money-and-acquire-better-armor/) | ~28 min | 534 | Make money and acquire better armor |
| [2026-01-23T20-14-19](./2026-01-23T20-14-19-gabe1-make-money-and-acquire-better-armor/) | ~22 min | 419 | Make money and acquire better armor |
| [2026-01-23T20-00-32](./2026-01-23T20-00-32-gabe1-make-money-and-acquire-better-armor/) | ~14 min | 344 | Make money and acquire better armor |
| [2026-01-23T19-38-24](./2026-01-23T19-38-24-gabe1-train-combat-skills-make-money-and-upgra/) | ~18 min | 488 | Train combat, make money, upgrade armor |
| [2026-01-23T19-26-22](./2026-01-23T19-26-22-gabe1-train-combat-skills-make-money-and-upgra/) | ~12 min | 282 | Train combat, make money, upgrade armor |

### default Account

| Run | Duration | Events | Goal |
|-----|----------|--------|------|
| [2026-01-23T20-36-07](./2026-01-23T20-36-07-default-make-money-and-acquire-better-armor/) | ~31 min | 490 | Make money and acquire better armor |
| [2026-01-23T20-14-26](./2026-01-23T20-14-26-default-make-money-and-acquire-better-armor/) | ~22 min | 425 | Make money and acquire better armor |
| [2026-01-23T20-00-26](./2026-01-23T20-00-26-default-make-money-and-acquire-better-armor/) | ~14 min | 314 | Make money and acquire better armor |

### bkl7c9 Account

| Run | Duration | Events | Goal |
|-----|----------|--------|------|
| [2026-01-23T20-35-59](./2026-01-23T20-35-59-bkl7c9-make-money-and-acquire-better-armor/) | ~23 min | 499 | Make money and acquire better armor |
| [2026-01-23T20-15-24](./2026-01-23T20-15-24-bkl7c9-make-money-and-acquire-better-armor/) | ~15 min | 367 | Make money and acquire better armor |
| [2026-01-23T20-00-29](./2026-01-23T20-00-29-bkl7c9-make-money-and-acquire-better-armor/) | ~20 min | 391 | Make money and acquire better armor |
| [2026-01-23T19-26-10](./2026-01-23T19-26-10-bkl7c9-train-combat-skills-make-money-and-upgra/) | ~25 min | 574 | Train combat, make money, upgrade armor |
