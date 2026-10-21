import { describe, expect, it } from 'vitest';
import { parseStep, stepText, STEP_PATTERNS } from '@izaro/shared';

describe('scenario sentences', () => {
  it('parses every documented example and renders it back', () => {
    for (const { example } of STEP_PATTERNS) {
      const r = parseStep(example);
      expect(r.ok, example).toBe(true);
      if (r.ok) expect(stepText(r.action)).toBe(example);
    }
  });
  it('accepts numbering, curly quotes, a full stop and synonyms', () => {
    expect(parseStep('3. Type “94105” into “ZIP code”.')).toEqual({ ok: true, action: { kind: 'enter', value: '94105', target: 'ZIP code' } });
    expect(parseStep('- tap on "Save"')).toEqual({ ok: true, action: { kind: 'click', target: 'Save' } });
    expect(parseStep('Expect to be on the "Plans" page')).toEqual({ ok: true, action: { kind: 'expectScreen', screen: 'Plans' } });
  });
  it('keeps secrets as placeholders', () => {
    expect(parseStep('Enter "{{secret:AUT_PASSWORD}}" in "Password"')).toMatchObject({ ok: true, action: { value: '{{secret:AUT_PASSWORD}}' } });
  });
  it('rejects free-form sentences with a hint', () => {
    const r = parseStep('buy the cheapest family plan');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Click "Sign in"/);
  });
});
