import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelProviders } from '../../src/renderer/src/ModelProviders'

const openForm = async (): Promise<void> => {
  render(<ModelProviders onStatus={vi.fn()} />)
  await userEvent.click(await screen.findByRole('button', { name: 'Add a model provider…' }))
}

const pick = async (provider: RegExp): Promise<void> => {
  await userEvent.click(screen.getByLabelText('Provider'))
  await userEvent.click(screen.getByRole('option', { name: provider }))
}

const addButton = (): HTMLElement => screen.getByRole('button', { name: 'Add provider' })

describe('Settings › Providers › add form', () => {
  it('opens on Anthropic with working values, so only the key is left to paste', async () => {
    await openForm()
    expect(screen.getByLabelText('Provider')).toHaveFocus()
    expect(screen.getByLabelText('Display name')).toHaveValue('Anthropic')
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.anthropic.com')
    // the Anthropic API refuses a request without a key — adding one keyless is refused here
    expect(screen.getByLabelText('API key')).toBeInTheDocument()
    expect(addButton()).toBeDisabled()
    // a vendor's own API has nothing to tune: no wire API, key header or custom headers
    expect(screen.queryByLabelText('Wire API')).toBeNull()
    expect(screen.queryByLabelText('Send key as')).toBeNull()
    expect(screen.queryByLabelText('Headers · optional')).toBeNull()

    await userEvent.type(screen.getByLabelText('API key'), 'sk-ant-api03-test')
    expect(addButton()).toBeEnabled()
    await userEvent.click(addButton())
    expect(window.cockpit.addModelEndpoint).toHaveBeenCalledWith({
      label: 'Anthropic',
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-api03-test',
      wireApi: undefined,
      auth: 'key',
      headers: undefined
    })
  })

  it('a local server fills its own port and needs no key', async () => {
    await openForm()
    await pick(/^Ollama/)
    expect(screen.getByLabelText('Display name')).toHaveValue('Ollama')
    expect(screen.getByLabelText('Base URL')).toHaveValue('http://localhost:11434/v1')
    expect(screen.getByLabelText('API key · optional')).toBeInTheDocument()
    expect(screen.getByText(/no key is needed/)).toBeInTheDocument()
    expect(addButton()).toBeEnabled()
    await userEvent.click(addButton())
    expect(window.cockpit.addModelEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'openai', baseUrl: 'http://localhost:11434/v1', auth: undefined })
    )
  })

  it('OpenAI starts on the responses wire API its current models need', async () => {
    await openForm()
    await pick(/^OpenAI(?!-)/)
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.openai.com/v1')
    expect(screen.getByLabelText('Wire API')).toHaveTextContent('responses')
  })

  it('a suggestion follows the provider, but what was typed over it stays', async () => {
    await openForm()
    const name = screen.getByLabelText('Display name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Work Anthropic')
    await pick(/^LM Studio/)
    expect(name).toHaveValue('Work Anthropic')
    // the URL was still Anthropic's suggestion, so it moved on with the pick
    expect(screen.getByLabelText('Base URL')).toHaveValue('http://localhost:1234/v1')
    // Azure has no address of its own: the field empties and shows an example instead
    await pick(/^Azure OpenAI/)
    expect(screen.getByLabelText('Base URL')).toHaveValue('')
    expect(screen.getByLabelText('Base URL')).toHaveAttribute(
      'placeholder',
      'https://my-resource.openai.azure.com'
    )
  })

  it('a gateway asks how it takes the key, defaulting to a bearer token', async () => {
    await openForm()
    await pick(/^Anthropic-compatible/)
    expect(screen.getByLabelText('Display name')).toHaveValue('')
    expect(screen.getByLabelText('Send key as')).toHaveTextContent('Bearer')
    await userEvent.type(screen.getByLabelText('Display name'), 'litellm')
    await userEvent.type(screen.getByLabelText('Base URL'), 'http://localhost:4000')
    await userEvent.type(screen.getByLabelText('Headers · optional'), '{{"X-Tenant-Id": "a"}')
    await userEvent.click(screen.getByLabelText('Send key as'))
    await userEvent.click(screen.getByRole('option', { name: /^x-api-key/ }))
    await userEvent.click(addButton())
    expect(window.cockpit.addModelEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'litellm',
        type: 'anthropic',
        auth: 'key',
        headers: { 'X-Tenant-Id': 'a' }
      })
    )
  })

  it('headers typed for a gateway are dropped when the pick no longer shows them', async () => {
    await openForm()
    await pick(/^OpenAI-compatible/)
    await userEvent.type(screen.getByLabelText('Headers · optional'), '{{"X-A": "b"}')
    await pick(/^Ollama/)
    await userEvent.click(addButton())
    expect(window.cockpit.addModelEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ headers: undefined })
    )
  })

  it('folds after an add and reopens on the defaults', async () => {
    await openForm()
    await pick(/^Ollama/)
    await userEvent.click(addButton())
    await userEvent.click(await screen.findByRole('button', { name: 'Add a model provider…' }))
    expect(screen.getByLabelText('Display name')).toHaveValue('Anthropic')
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.anthropic.com')
  })
})
