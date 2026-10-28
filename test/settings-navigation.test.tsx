import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsNavigation } from '../src/web/settings-navigation.js';

describe('settings navigation shell', () => {
  it('renders interactive children once and exposes the current page on the mobile trigger', () => {
    let renderCount = 0;
    function PageButton() {
      renderCount += 1;
      return <button type="button">General</button>;
    }

    const markup = renderToStaticMarkup(
      <SettingsNavigation currentPageLabel="General">
        <PageButton />
        <button type="button">Developer</button>
      </SettingsNavigation>,
    );

    expect(renderCount).toBe(1);
    expect(markup).toContain('aria-label="Settings page: General"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Settings pages"');
    expect(markup.match(/>General<\/button>/g)).toHaveLength(1);
    expect(markup).toContain('Developer');
  });
});
