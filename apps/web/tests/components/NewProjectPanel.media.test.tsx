// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewProjectPanel } from '../../src/components/NewProjectPanel';

describe('NewProjectPanel media provider badges', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('treats daemon-restored apiKeyConfigured providers as configured', () => {
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={vi.fn()}
        mediaProviders={{
          openai: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '1234',
            baseUrl: '',
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    // Model picker is now a combobox — open the popover so the
    // provider group + status badge become visible in the DOM.
    fireEvent.click(screen.getByTestId('model-picker-trigger'));

    const openaiGroup = screen.getByText('OpenAI').closest('.ds-picker-group');
    expect(openaiGroup?.textContent).toContain('Configured');
    expect(openaiGroup?.textContent).not.toContain('Integrated');
  });

  it('hides provider models until the provider has usable credentials', () => {
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={vi.fn()}
        mediaProviders={{}}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    fireEvent.click(screen.getByTestId('model-picker-trigger'));

    expect(screen.queryByText('OpenAI')).toBeNull();
    expect(screen.queryByTestId('model-picker-option-gpt-image-2')).toBeNull();
  });

  it('uses Higgsfield as the default image provider without media API credentials', async () => {
    const onCreate = vi.fn();
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={onCreate}
        mediaProviders={{}}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    await waitFor(() => {
      expect(screen.getByTestId('model-picker-trigger').textContent).toContain('GPT Image 2 (HiggsField)');
    });
    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Higgsfield default image' },
    });
    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          kind: 'image',
          imageModel: 'higgsfield/gpt-image-2',
          imageAspect: '1:1',
        }),
      }),
    );
  });

  it('uses Vela as the default video provider without media API credentials', async () => {
    const onCreate = vi.fn();
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={onCreate}
        mediaProviders={{}}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Video' }));
    await waitFor(() => {
      expect(screen.getByTestId('model-picker-trigger').textContent).toContain('seedance-2.0 (Cloud)');
    });
    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Vela default video' },
    });
    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          kind: 'video',
          videoModel: 'vela/doubao-seedance-2-0-260128',
          videoAspect: '16:9',
          videoLength: 5,
        }),
      }),
    );
  });

  it('shows only the Vela-supported video aspects and durations when Vela is selected', async () => {
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={vi.fn()}
        mediaProviders={{}}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Video' }));
    await waitFor(() => {
      expect(screen.getByTestId('model-picker-trigger').textContent).toContain('seedance-2.0 (Cloud)');
    });

    const aspectRadios = screen.getAllByRole('radio');
    expect(aspectRadios.map((radio) => radio.textContent)).toEqual(['1:1', '16:9', '9:16']);

    const lengthSelect = screen.getByLabelText('Length') as HTMLSelectElement;
    expect([...lengthSelect.options].map((option) => option.value)).toEqual(['5', '10']);
  });

  it('normalizes class-incompatible video aspect and duration to Vela-safe values when Vela takes over', async () => {
    const onCreate = vi.fn();
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={onCreate}
        mediaProviders={{
          volcengine: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '5678',
            baseUrl: '',
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Video' }));
    // The generic option set stays available for the non-Vela model.
    fireEvent.click(screen.getByTestId('model-picker-trigger'));
    fireEvent.click(screen.getByTestId('model-picker-option-doubao-seedance-2-0-260128'));
    fireEvent.click(screen.getByRole('radio', { name: '4:3' }));
    fireEvent.change(screen.getByLabelText('Length'), { target: { value: '15' } });

    // Selecting the managed Vela route must drop the choices the daemon rejects.
    fireEvent.click(screen.getByTestId('model-picker-trigger'));
    fireEvent.click(screen.getByTestId('model-picker-option-vela/doubao-seedance-2-0-260128'));
    await waitFor(() => {
      expect(screen.getByTestId('model-picker-trigger').textContent).toContain('seedance-2.0 (Cloud)');
    });

    expect(screen.queryByRole('radio', { name: '4:3' })).toBeNull();
    expect((screen.getByLabelText('Length') as HTMLSelectElement).value).toBe('5');

    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Normalized Vela video' },
    });
    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          kind: 'video',
          videoModel: 'vela/doubao-seedance-2-0-260128',
          videoAspect: '16:9',
          videoLength: 5,
        }),
      }),
    );
  });

  it('normalizes a template-recommended video aspect the managed Vela route rejects', async () => {
    const template = {
      id: 'vela-4-3-video-template',
      surface: 'video' as const,
      title: 'Legacy wide video template',
      summary: 'A managed video template that recommends a wide aspect.',
      category: 'Cinematic',
      tags: ['video'],
      model: 'vela/doubao-seedance-2-0-260128',
      aspect: '4:3' as const,
      source: {
        repo: 'example/templates',
        license: 'MIT',
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      promptTemplate: {
        ...template,
        prompt: 'A detailed cinematic video prompt with enough content for validation.',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const onCreate = vi.fn();

    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[template]}
        onCreate={onCreate}
        mediaProviders={{}}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Video' }));
    fireEvent.click(screen.getByTestId('prompt-template-trigger'));
    fireEvent.click(screen.getByRole('option', { name: /Legacy wide video template/ }));
    await waitFor(() => {
      expect(screen.getByTestId('prompt-template-body')).toHaveValue(
        'A detailed cinematic video prompt with enough content for validation.',
      );
    });
    // The template's 4:3 choice is not renderable on the managed route.
    expect(screen.queryByRole('radio', { name: '4:3' })).toBeNull();
    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Managed template video' },
    });
    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          kind: 'video',
          videoModel: 'vela/doubao-seedance-2-0-260128',
          videoAspect: '16:9',
          videoLength: 5,
        }),
      }),
    );
  });

  it('normalizes a template aspect against the current Vela model when model is omitted', async () => {
    const template = {
      id: 'model-optional-vela-video-template',
      surface: 'video' as const,
      title: 'Current model video template',
      summary: 'A video template that leaves the current model selected.',
      category: 'Cinematic',
      tags: ['video'],
      aspect: '4:3' as const,
      source: {
        repo: 'example/templates',
        license: 'MIT',
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      promptTemplate: {
        ...template,
        prompt: 'A detailed model-optional video prompt with enough content for validation.',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const onCreate = vi.fn();

    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[template]}
        onCreate={onCreate}
        mediaProviders={{}}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Video' }));
    await waitFor(() => {
      expect(screen.getByTestId('model-picker-trigger').textContent).toContain('seedance-2.0 (Cloud)');
    });
    fireEvent.click(screen.getByTestId('prompt-template-trigger'));
    fireEvent.click(screen.getByRole('option', { name: /Current model video template/ }));
    await waitFor(() => {
      expect(screen.getByTestId('prompt-template-body')).toHaveValue(
        'A detailed model-optional video prompt with enough content for validation.',
      );
    });
    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Model-optional Vela video' },
    });
    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          kind: 'video',
          videoModel: 'vela/doubao-seedance-2-0-260128',
          videoAspect: '16:9',
          videoLength: 5,
        }),
      }),
    );
  });

  it('normalizes incompatible state when a model-only template switches to Vela', async () => {
    const template = {
      id: 'aspect-optional-vela-video-template',
      surface: 'video' as const,
      title: 'Managed model video template',
      summary: 'A managed video template that leaves the current aspect selected.',
      category: 'Cinematic',
      tags: ['video'],
      model: 'vela/doubao-seedance-2-0-260128',
      source: {
        repo: 'example/templates',
        license: 'MIT',
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      promptTemplate: {
        ...template,
        prompt: 'A detailed aspect-optional video prompt with enough content for validation.',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const onCreate = vi.fn();

    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[template]}
        onCreate={onCreate}
        mediaProviders={{
          volcengine: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '5678',
            baseUrl: '',
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Video' }));
    fireEvent.click(screen.getByTestId('model-picker-trigger'));
    fireEvent.click(screen.getByTestId('model-picker-option-doubao-seedance-2-0-260128'));
    fireEvent.click(screen.getByRole('radio', { name: '4:3' }));
    fireEvent.change(screen.getByLabelText('Length'), { target: { value: '15' } });
    fireEvent.click(screen.getByTestId('prompt-template-trigger'));
    fireEvent.click(screen.getByRole('option', { name: /Managed model video template/ }));
    await waitFor(() => {
      expect(screen.getByTestId('prompt-template-body')).toHaveValue(
        'A detailed aspect-optional video prompt with enough content for validation.',
      );
    });
    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Aspect-optional Vela video' },
    });
    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          kind: 'video',
          videoModel: 'vela/doubao-seedance-2-0-260128',
          videoAspect: '16:9',
          videoLength: 5,
        }),
      }),
    );
  });

  it('treats a legacy template gpt-image-2 recommendation as the managed Cloud route', async () => {
    const template = {
      id: 'legacy-gpt-image-template',
      surface: 'image' as const,
      title: 'Legacy GPT image template',
      summary: 'A legacy first-party image template.',
      category: 'Poster',
      tags: ['legacy'],
      model: 'gpt-image-2',
      aspect: '16:9' as const,
      source: {
        repo: 'example/templates',
        license: 'MIT',
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      promptTemplate: {
        ...template,
        prompt: 'A detailed cinematic image prompt with enough content for validation.',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const onCreate = vi.fn();

    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[template]}
        onCreate={onCreate}
        mediaProviders={{
          openai: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '1234',
            baseUrl: '',
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    fireEvent.click(screen.getByTestId('prompt-template-trigger'));
    fireEvent.click(screen.getByRole('option', { name: /Legacy GPT image template/ }));
    await waitFor(() => {
      expect(screen.getByTestId('prompt-template-body')).toHaveValue(
        'A detailed cinematic image prompt with enough content for validation.',
      );
    });
    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Managed template image' },
    });
    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          kind: 'image',
          imageModel: 'vela/gpt-image-2',
          imageAspect: '16:9',
          promptTemplate: expect.objectContaining({
            model: 'vela/gpt-image-2',
          }),
        }),
      }),
    );
  });

  it('preserves an explicit OpenAI model picker selection as BYOK', () => {
    const onCreate = vi.fn();
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={onCreate}
        mediaProviders={{
          openai: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '1234',
            baseUrl: '',
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    fireEvent.click(screen.getByTestId('model-picker-trigger'));
    fireEvent.click(screen.getByTestId('model-picker-option-gpt-image-2'));
    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Explicit BYOK image' },
    });
    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          imageModel: 'gpt-image-2',
        }),
      }),
    );
  });

  it('does not treat OpenAI OAuth-only markers as usable image credentials', () => {
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={vi.fn()}
        mediaProviders={{
          openai: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '',
            source: 'oauth-codex',
            baseUrl: '',
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    fireEvent.click(screen.getByTestId('model-picker-trigger'));

    expect(screen.queryByText('OpenAI')).toBeNull();
    expect(screen.queryByTestId('model-picker-option-gpt-image-2')).toBeNull();
  });

  it('keeps the Higgsfield default when another provider is configured', () => {
    const onCreate = vi.fn();
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={onCreate}
        mediaProviders={{
          volcengine: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '5678',
            baseUrl: '',
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Configured provider image' },
    });
    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          imageModel: 'higgsfield/gpt-image-2',
        }),
      }),
    );
  });
});
