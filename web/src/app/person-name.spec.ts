import { describe, expect, it } from 'vitest';
import { normalizePersonName } from './person-name';

describe('normalizePersonName', () => {
  it.each([
    ['FRED L LLOYD', 'Fred L Lloyd'],
    ['JAMES MCDONALD', 'James McDonald'],
    ['MARY MCINTYRE', 'Mary McIntyre'],
    ['IAN MACDONALD', 'Ian MacDonald'],
    ['MARCOS MACHADO', 'Marcos Machado'],
    ["SEAN O'CONNOR", "Sean O'Connor"],
    ['ANNE-MARIE VAN DYKE', 'Anne-Marie Van Dyke'],
    ['LUDWIG VAN BEETHOVEN', 'Ludwig Van Beethoven'],
    ['MARTIN LUTHER KING JR.', 'Martin Luther King Jr.'],
    ['JOHN SMITH, III', 'John Smith, III'],
    ['J.R.R. TOLKIEN', 'J.R.R. Tolkien'],
    ['ROBERT DOWNEY, JR.', 'Robert Downey, Jr.'],
    ['JANE DOE PHD', 'Jane Doe PHD'],
    ['FRED "THE BOSS" LLOYD', 'Fred "The Boss" Lloyd'],
    ['  FRED   LLOYD  ', 'Fred Lloyd'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizePersonName(input)).toBe(expected);
  });

  it('preserves user-supplied mixed capitalization', () => {
    expect(normalizePersonName('Neil deGrasse Tyson')).toBe('Neil deGrasse Tyson');
    expect(normalizePersonName('LeVar Burton')).toBe('LeVar Burton');
  });
});
