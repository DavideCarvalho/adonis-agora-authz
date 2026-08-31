import { render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Can } from '../src/components/can.js';
import { AuthzProvider } from '../src/provider.js';

afterEach(() => {
  document.body.innerHTML = '';
});

function renderCan(
  share: { roles: string[]; permissions: string[] },
  props: { permission?: string; role?: string; fallback?: ReactNode } = {},
) {
  return render(
    createElement(
      AuthzProvider,
      { value: share },
      createElement(
        Can,
        { ...props, fallback: props.fallback ?? createElement('span', null, 'denied') },
        createElement('span', null, 'allowed'),
      ),
    ),
  );
}

describe('<Can>', () => {
  it('permite quando a permissão exata está no share', () => {
    renderCan({ roles: [], permissions: ['posts.edit'] }, { permission: 'posts.edit' });
    expect(screen.getByText('allowed')).toBeTruthy();
    expect(screen.queryByText('denied')).toBeNull();
  });

  it('permite via wildcard', () => {
    renderCan({ roles: [], permissions: ['posts.*'] }, { permission: 'posts.edit' });
    expect(screen.getByText('allowed')).toBeTruthy();
    expect(screen.queryByText('denied')).toBeNull();
  });

  it('nega e renderiza o fallback quando a permissão não está no share', () => {
    renderCan({ roles: [], permissions: ['posts.view'] }, { permission: 'posts.delete' });
    expect(screen.queryByText('allowed')).toBeNull();
    expect(screen.getByText('denied')).toBeTruthy();
  });

  it('nega quando o share está vazio (deslogado / fail-closed)', () => {
    renderCan({ roles: [], permissions: [] }, { permission: 'posts.edit' });
    expect(screen.queryByText('allowed')).toBeNull();
    expect(screen.getByText('denied')).toBeTruthy();
  });

  it('gateia por role quando `role` é passado', () => {
    renderCan({ roles: ['admin'], permissions: [] }, { role: 'admin' });
    expect(screen.getByText('allowed')).toBeTruthy();

    renderCan({ roles: ['editor'], permissions: [] }, { role: 'admin' });
    expect(screen.getByText('denied')).toBeTruthy();
  });
});
