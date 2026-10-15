// ============================================================================
// TINY WARFARE — src/ai/skill.js
//
// Bot difficulty. Each tier is one profile of numbers that the bot brain
// (src/ai/bots.js) reads in place of fixed constants: how fast a bot reacts,
// turns, and settles its aim, how wide it sees and how far it hears, whether
// it switches to a more dangerous target, and how often it throws grenades.
//
// RECRUIT is slow and loose and fights one enemy at a time. REGULAR is the
// original bot. VETERAN reacts and turns fast, leads moving targets, goes for
// the head, and fights the most dangerous enemy in view.
//
// A match runs one tier for every bot. Solo play reads the menu pick; an
// online room carries the host's pick so a new authority keeps it.
// ============================================================================

export const BOT_SKILL_IDS = Object.freeze(['recruit', 'regular', 'veteran']);
export const DEFAULT_BOT_SKILL = 'regular';
export const BOT_SKILL_STORAGE_KEY = 'tiny-strike-bot-skill';

export const BOT_SKILLS = Object.freeze({
  recruit: Object.freeze({
    id: 'recruit',
    label: 'RECRUIT',
    detail: 'FORGIVING',
    reaction: [0.40, 0.85],   // s from first sight to first shot
    repeek: 0.6,              // fraction of a reaction paid when a lost target reappears
    turnSpeed: 4.5,           // rad/s exponential aim chase
    lead: 0,                  // fraction of the chase lag aimed ahead of a mover
    onTarget: 0.20,           // rad off the target the trigger still pulls at
    aimError: 2.2,            // deg, base gaussian error per shot
    settle: [1.5, 1.4],       // extra error on a fresh target, and its decay rate
    moving: 1.9,              // error multiplier while the bot runs
    bloom: 0.25,              // deg added per shot in a burst
    burst: 0.7,               // burst length multiplier
    pause: 1.5,               // pause between bursts multiplier
    headChance: 0,            // chance a burst aims at the head instead of the chest
    fov: 90,                  // deg
    engageRange: 32,          // m
    hearing: 0.7,             // hearing range multiplier
    investigate: 0.4,         // chance to go and check a noise
    loseTime: 1.4,            // s unseen before a target becomes a memory
    switching: 'none',        // none | attacker | threat
    damageTurn: 0.25,         // fraction of the turn toward an unseen attacker on a hit
    strafe: 0.5,              // engaged strafe speed, fraction of run speed
    strafeStop: 0.3,          // chance a strafe change is a standstill feint
    crouchFar: 0.15,          // chance to take a knee for the next burst at range
    huntSense: 0.45,          // chance a respawn-mode bot heads for the nearest enemy
    blindSpray: 0.15,         // chance a flashed bot sprays at the last-seen spot
    blindError: 1.3,          // flashed aim error multiplier
    grenade: 0,               // chance to frag a target that ducked behind cover
    dodge: 0.3,               // chance to run from a live grenade nearby
    reloadCover: false,       // backpedal and strafe away while reloading in a fight
  }),
  regular: Object.freeze({
    id: 'regular',
    label: 'REGULAR',
    detail: 'BALANCED',
    reaction: [0.22, 0.55],
    repeek: 0.45,
    turnSpeed: 8,
    lead: 0,
    onTarget: 0.12,
    aimError: 1.2,
    settle: [0.9, 2.2],
    moving: 1.55,
    bloom: 0.12,
    burst: 1,
    pause: 1,
    headChance: 0.08,
    fov: 110,
    engageRange: 45,
    hearing: 1,
    investigate: 0.6,
    loseTime: 2.2,
    switching: 'attacker',
    damageTurn: 0.6,
    strafe: 0.62,
    strafeStop: 0.18,
    crouchFar: 0.35,
    huntSense: 0.7,
    blindSpray: 0.3,
    blindError: 1,
    grenade: 0.3,
    dodge: 0.7,
    reloadCover: true,
  }),
  veteran: Object.freeze({
    id: 'veteran',
    label: 'VETERAN',
    detail: 'PUNISHING',
    reaction: [0.14, 0.32],
    repeek: 0.35,
    turnSpeed: 12,
    lead: 0.5,
    onTarget: 0.07,
    aimError: 0.75,
    settle: [0.6, 3.0],
    moving: 1.3,
    bloom: 0.06,
    burst: 1,
    pause: 0.75,
    headChance: 0.25,
    fov: 130,
    engageRange: 55,
    hearing: 1.25,
    investigate: 0.8,
    loseTime: 3.0,
    switching: 'threat',
    damageTurn: 1,
    strafe: 0.7,
    strafeStop: 0.1,
    crouchFar: 0.45,
    huntSense: 0.85,
    blindSpray: 0.4,
    blindError: 0.8,
    grenade: 0.55,
    dodge: 1,
    reloadCover: true,
  }),
});

/** A known tier id, or the default for anything else. */
export function normalizeBotSkill(value) {
  const id = String(value || '').toLowerCase();
  return BOT_SKILL_IDS.includes(id) ? id : DEFAULT_BOT_SKILL;
}

/** The profile for a tier id (the default for an unknown one). */
export function botSkill(value) {
  return BOT_SKILLS[normalizeBotSkill(value)];
}
