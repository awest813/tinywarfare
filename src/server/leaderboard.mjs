import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  DEFAULT_LEADERBOARD_SEASON,
  LEADERBOARD_CATEGORIES,
  LEADERBOARD_MAPS,
  LEADERBOARD_MODES,
  LEADERBOARD_RULES,
  LEADERBOARD_SCHEMA_VERSION,
  LeaderboardError,
  cleanLeaderboardMode,
  cleanLeaderboardName,
  ensureLeaderboardPlayerShape,
  leaderboardFromData,
  newLeaderboardData,
  playerStandingFromData,
  progressionFromData,
  publicLeaderboardRules,
  submitMatchToData,
} from '../shared/leaderboard-core.mjs';

export {
  LEADERBOARD_CATEGORIES,
  LEADERBOARD_MAPS,
  LEADERBOARD_MODES,
  LEADERBOARD_RULES,
  LeaderboardError,
};

function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Persistent leaderboard store for the single-process development deployment.
 * Production uses the SQLite Durable Object, while both stores share every
 * scoring and progression mutation through leaderboard-core.mjs.
 */

// One day longer than the seven-day window in which a result is accepted.
const MATCH_RECORD_TTL_MS = 8 * 24 * 60 * 60 * 1000;
const MATCH_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export class LeaderboardStore {
  constructor({
    filePath,
    season = DEFAULT_LEADERBOARD_SEASON,
    now = () => Date.now(),
    makeId = () => randomUUID(),
    makeToken = () => `ts_${randomBytes(24).toString('base64url')}`,
  } = {}) {
    if (!filePath) throw new TypeError('LeaderboardStore requires filePath.');
    this.filePath = filePath;
    this.now = now;
    this.makeId = makeId;
    this.makeToken = makeToken;
    this.data = this._load(season);
  }

  _load(season) {
    if (!existsSync(this.filePath)) return newLeaderboardData(season);
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!parsed || parsed.version !== LEADERBOARD_SCHEMA_VERSION || typeof parsed.players !== 'object') {
        throw new Error('Unsupported leaderboard data schema.');
      }
      parsed.sessions ||= {};
      parsed.matches ||= {};
      parsed.daily ||= {};
      for (const player of Object.values(parsed.players)) ensureLeaderboardPlayerShape(player);
      return parsed;
    } catch (error) {
      const recoveryPath = `${this.filePath}.corrupt-${Date.now()}`;
      renameSync(this.filePath, recoveryPath);
      console.error(`[leaderboard] Preserved unreadable data at ${recoveryPath}: ${error.message}`);
      return newLeaderboardData(season);
    }
  }

  _save() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempPath, this.filePath);
  }

  rules() {
    return publicLeaderboardRules();
  }

  _sessionResponse(player, token, resumed) {
    return {
      player: { id: player.id, name: player.name },
      token,
      resumed,
      progression: progressionFromData(this.data, player.id, this.now()),
    };
  }

  createSession({ playerName, token } = {}) {
    const suppliedToken = String(token || '').trim();
    if (suppliedToken) {
      const player = this.authenticate(suppliedToken);
      if (!player) throw new LeaderboardError(401, 'That leaderboard session is no longer valid.');
      player.name = cleanLeaderboardName(playerName || player.name);
      player.updatedAt = new Date(this.now()).toISOString();
      this._save();
      return this._sessionResponse(player, suppliedToken, true);
    }

    const createdAt = new Date(this.now()).toISOString();
    const id = this.makeId();
    const sessionToken = this.makeToken();
    const player = ensureLeaderboardPlayerShape({
      id,
      name: cleanLeaderboardName(playerName),
      createdAt,
      updatedAt: createdAt,
      lastPlayedAt: null,
      stats: {},
    });
    this.data.players[id] = player;
    this.data.sessions[tokenHash(sessionToken)] = { playerId: id, createdAt };
    this._save();
    return this._sessionResponse(player, sessionToken, false);
  }

  authenticate(token) {
    const value = String(token || '').trim();
    if (!value || value.length > 256) return null;
    const session = this.data.sessions[tokenHash(value)];
    if (!session) return null;
    const player = this.data.players[session.playerId] || null;
    return player ? ensureLeaderboardPlayerShape(player) : null;
  }

  me(token) {
    const player = this.authenticate(token);
    if (!player) throw new LeaderboardError(401, 'A valid leaderboard session is required.');
    return {
      player: { id: player.id, name: player.name },
      standing: playerStandingFromData(this.data, player.id),
      progression: progressionFromData(this.data, player.id, this.now()),
    };
  }

  submitMatch(token, payload) {
    const player = this.authenticate(token);
    if (!player) throw new LeaderboardError(401, 'A valid leaderboard session is required.');
    const mode = cleanLeaderboardMode(payload && payload.mode);
    if (mode === 'humans' || mode === 'mixed') {
      throw new LeaderboardError(403, 'Human and mixed matches are ranked from the live room server.');
    }
    return this.submitMatchForPlayer(player.id, payload);
  }

  /** Used by the WebSocket room after associating a ranked identity. */
  submitMatchForPlayer(playerId, payload) {
    const now = this.now();
    const result = submitMatchToData(this.data, playerId, payload, now);
    if (!result.duplicate) {
      this._pruneMatches(now);
      this._save();
    }
    return result;
  }

  /**
   * Accepted results are kept only to recognise a retry of the same match,
   * and results older than seven days are refused anyway, so records past
   * MATCH_RECORD_TTL_MS go. Without this the file (read whole at boot,
   * rewritten on every result) grew with every match ever played.
   */
  _pruneMatches(now) {
    if (now - (this._prunedAt || 0) < MATCH_PRUNE_INTERVAL_MS) return;
    this._prunedAt = now;
    const matches = this.data.matches;
    if (!matches) return;
    for (const [key, record] of Object.entries(matches)) {
      const at = Date.parse(record && record.acceptedAt);
      if (Number.isFinite(at) && now - at > MATCH_RECORD_TTL_MS) delete matches[key];
    }
  }

  playerStanding(playerId) {
    return playerStandingFromData(this.data, playerId);
  }

  progression(playerId) {
    return progressionFromData(this.data, playerId, this.now());
  }

  leaderboard(category = 'overall', limit = 50) {
    return leaderboardFromData(this.data, category, limit, this.now());
  }
}
