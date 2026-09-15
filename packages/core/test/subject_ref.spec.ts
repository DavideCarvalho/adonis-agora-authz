import { describe, expect, it } from 'vitest';
import { identitySubjectRef } from '../src/subject_ref.js';

describe('identitySubjectRef', () => {
  it('maps an identity with userId to a user ref', () => {
    expect(identitySubjectRef({ userId: 'u1' })).toEqual({ type: 'user', id: 'u1' });
  });

  it('coerces a numeric id to a string', () => {
    expect(identitySubjectRef({ userId: 42 })).toEqual({ type: 'user', id: '42' });
  });

  it('is tolerant of a bare id field', () => {
    expect(identitySubjectRef({ id: 7 })).toEqual({ type: 'user', id: '7' });
  });

  it('falls back when neither userId nor id is present', () => {
    expect(identitySubjectRef({})).toBeUndefined();
  });
});
