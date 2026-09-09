import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserStore } from '../services/central-reference-service/dist/users.js';
import { hashPassword, verifyPassword } from '../shared/dist/index.js';

describe('UserStore refresh tokens', () => {
  it('rotates once and revokes the family on reuse', () => {
    const users = new UserStore([]);
    const user = users.create('user@example.test', 'password123', 'viewer');
    const initial = users.issueRefreshToken(user.userId);

    const firstRotation = users.rotateRefreshToken(initial);
    assert.ok(firstRotation);
    assert.equal(firstRotation.userId, user.userId);

    const secondRotation = users.rotateRefreshToken(firstRotation.newToken);
    assert.ok(secondRotation);
    assert.notEqual(secondRotation.newToken, firstRotation.newToken);

    assert.equal(users.rotateRefreshToken(initial), null);
    assert.equal(users.rotateRefreshToken(firstRotation.newToken), null);
    assert.equal(users.rotateRefreshToken(secondRotation.newToken), null);
  });
});

describe('password hashing', () => {
  it('uses a unique salt and verifies only the original password', () => {
    const first = hashPassword('password123');
    const second = hashPassword('password123');
    assert.notEqual(first, second);
    assert.equal(verifyPassword('password123', first), true);
    assert.equal(verifyPassword('password123', second), true);
    assert.equal(verifyPassword('wrong-password', first), false);
  });
});
