# Lab Log: varrock-travel

## Purpose
Test long-distance navigation using `bot.walkTo()` from Lumbridge to Varrock (~220 tiles).

## Configuration
- Start: Lumbridge spawn (3222, 3218)
- Destination: Varrock West Bank (3185, 3436)
- Distance: ~220 tiles
- Time limit: 3 minutes
- Stall timeout: 60s

---

## Run 001 - Direct walkTo (FAILED)

**Outcome**: error
**Duration**: 16.1s

### What Happened
- Single `walkTo(3212, 3428)` call
- Bot walked from (3222, 3218) to (3212, 3270) - about 52 tiles
- Pathfinder returned "No path found"
- Stuck at z=3270 (roughly cow field area)

### Root Cause
Direct walkTo over 200+ tiles fails. Pathfinder has ~100 tile search radius and intermediate waypoint calculation (60 tiles) still gets stuck in problematic terrain.

### Fix
Use explicit waypoints with 20-30 tile segments, with retry logic per waypoint.

---

## Run 002 - Waypoint-based (SUCCESS)

**Outcome**: success
**Duration**: 81.7s

### What Happened
- Used 8 waypoints from Lumbridge to Varrock
- Most waypoints reached on first attempt
- Two retries needed:
  - Champion Guild area: stuck at (3260, 3277), retry succeeded
  - South Varrock: stuck at (3269, 3343), retry succeeded
- Arrived at (3212, 3418) - within Varrock area (z >= 3400)

### What Worked
- 20-30 tile waypoint segments
- 8-tile tolerance for intermediate waypoints
- Retry logic (3 attempts per waypoint)
- Early exit when reaching Varrock area (z >= 3400)

### Waypoints Used
```
1. (3232, 3245) - North of Lumbridge
2. (3250, 3270) - Near cow field
3. (3260, 3300) - North of cow field
4. (3255, 3330) - Champion Guild area
5. (3245, 3360) - South Varrock
6. (3230, 3390) - Varrock south entrance
7. (3210, 3420) - Near Varrock square
8. (3185, 3436) - Varrock West Bank
```

---

## Learnings

### 1. Strategic Findings
- **Direct walkTo fails for >100 tile distances** - pathfinder search radius is limited
- **Waypoints of 20-30 tiles work reliably** - within pathfinder range
- **Retry logic is essential** - some waypoints get stuck but succeed on retry
- **Known stuck points**: around (3260, 3277) and (3269, 3343) - terrain/collision issues

### 2. Process & Tooling Reflections
- events.jsonl clearly showed where pathfinding failed
- Explicit waypoint names in logs make debugging easier
- Progress tracking via `ctx.progress()` prevents stall detection during long walks

### 3. SDK Issues & Gaps
- `walkTo` returns "No path found" rather than a more informative partial-progress message
- Would be useful if `walkTo` returned how far it got when failing
- Intermediate waypoint calculation (60 tiles) in bot-actions.ts could use smaller steps
