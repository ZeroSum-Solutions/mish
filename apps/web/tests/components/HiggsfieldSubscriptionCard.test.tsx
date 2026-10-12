// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HiggsfieldSubscriptionCard } from '../../src/components/HiggsfieldSubscriptionCard';
import { I18nProvider } from '../../src/i18n';
const show = () => render(<I18nProvider initial="en"><HiggsfieldSubscriptionCard /></I18nProvider>);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('HiggsField subscription connection', () => {
  it('shows configured subscription without an API key input', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok:true,json:async()=>({providers:{higgsfield:{configured:true}}})}));
    show(); await screen.findByText('Subscription connected');
    expect(screen.queryByRole('button', {name:'Connect HiggsField'})).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('starts subscription sign-in through the daemon and refreshes status', async () => {
    let connected=false;
    const fetcher=vi.fn(async (url:string) => url.endsWith('/login') ? {ok:true} : {ok:true,json:async()=>({providers:{higgsfield:{configured:connected}}})});
    vi.stubGlobal('fetch',fetcher); show();
    await screen.findByText('Connect your subscription to generate images.');
    fireEvent.click(screen.getByRole('button',{name:'Connect HiggsField'}));
    await waitFor(()=>expect(fetcher).toHaveBeenCalledWith('/api/media/higgsfield/login',{method:'POST'}));
    connected=true;
    fireEvent.click(screen.getByRole('button',{name:'HiggsField details'}));
    fireEvent.click(screen.getByRole('button',{name:'Check connection'}));
    await screen.findByText('Subscription connected');
  });
  it('shows a failed sign-in and permits another attempt', async () => {
    vi.stubGlobal('fetch',vi.fn(async (url:string)=>url.endsWith('/login')?{ok:false}:{ok:true,json:async()=>({providers:{}})}));
    show(); await screen.findByText('Connect your subscription to generate images.');
    fireEvent.click(screen.getByRole('button',{name:'Connect HiggsField'}));
    await screen.findByText('Could not verify the connection. Check sign-in and try again.');
    expect(screen.getByRole('button',{name:'Connect HiggsField'}).hasAttribute('disabled')).toBe(false);
  });
  it('keeps one action in the row while disconnected and moves the re-check into the details', async () => {
    vi.stubGlobal('fetch',vi.fn(async ()=>({ok:true,json:async()=>({providers:{}})})));
    show(); await screen.findByText('Connect your subscription to generate images.');
    expect(screen.getByRole('button',{name:'Connect HiggsField'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Check connection'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'HiggsField details'}));
    expect(screen.getByRole('button',{name:'Check connection'})).toBeTruthy();
  });
  it('offers the re-check as the row action once connected', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({providers:{higgsfield:{configured:true}}})}));
    show(); await screen.findByText('Subscription connected');
    expect(screen.getByRole('button',{name:'Check connection'})).toBeTruthy();
  });
});
