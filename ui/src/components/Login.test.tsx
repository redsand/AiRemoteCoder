import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Login from './Login';

describe('Login', () => {
  it('renders the AI Remote Coder title', () => {
    const html = renderToStaticMarkup(<Login onLogin={() => {}} />);

    expect(html).toContain('AI Remote Coder');
  });
});
