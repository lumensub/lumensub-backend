import { describe, expect, it } from 'vitest';
import { page, pageQuery } from './pagination.js';

describe('pagination', () => {
  it('returns a cursor when there is another page', () => {
    const rows = [{ id: '9' }, { id: '8' }, { id: '7' }];
    expect(page(rows, 2)).toEqual({ data: [{ id: '9' }, { id: '8' }], next_cursor: '8' });
  });

  it('returns no cursor on the last page', () => {
    expect(page([{ id: '1' }], 2)).toEqual({ data: [{ id: '1' }], next_cursor: null });
  });

  it('validates the query', () => {
    expect(pageQuery.parse({})).toEqual({ limit: 50 });
    expect(() => pageQuery.parse({ limit: '500' })).toThrow();
    expect(() => pageQuery.parse({ cursor: 'abc' })).toThrow();
  });
});
