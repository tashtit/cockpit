import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NewSession } from '../../src/renderer/src/NewSession'
import type { RepoGroup } from '../../src/shared/types'
import type { ImageAttachment } from '../../src/renderer/src/attachments'
import { pasteImage, stubObjectUrls } from './paste'

const repo: RepoGroup = {
  key: '/home/dev/cachely',
  name: 'cachely',
  fullName: 'dev/cachely',
  root: '/home/dev/cachely',
  sessionCount: 2,
  archivedCount: 0,
  lastActivity: 1700000000000,
  providers: ['claude'],
  hidden: false
}

function renderForm(initialImages?: readonly ImageAttachment[]) {
  const onStart = vi.fn().mockResolvedValue(null)
  render(
    <NewSession
      repo={repo}
      repos={[repo]}
      busy={false}
      initialImages={initialImages}
      onStart={onStart}
      onCancel={() => {}}
    />
  )
  return { onStart }
}

beforeEach(() => {
  stubObjectUrls()
})

describe('NewSession image paste', () => {
  it('sends a pasted image with the first prompt', async () => {
    const { onStart } = renderForm()
    pasteImage(
      screen.getByLabelText('Task'),
      new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })
    )
    await waitFor(() => expect(screen.getByText('shot.png')).toBeInTheDocument())

    await userEvent.type(screen.getByLabelText('Task'), 'fix the layout')
    await userEvent.click(screen.getByRole('button', { name: 'Start session' }))

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'fix the layout',
        images: ['/tmp/chat-images/img.png']
      })
    )
  })

  it('adopts images handed over from the home composer and allows image-only start', async () => {
    const { onStart } = renderForm([
      { path: '/tmp/chat-images/carried.png', name: 'carried.png', url: 'blob:preview' }
    ])
    expect(screen.getByText('carried.png')).toBeInTheDocument()

    const start = screen.getByRole('button', { name: 'Start session' })
    expect(start).toBeEnabled()
    await userEvent.click(start)

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '', images: ['/tmp/chat-images/carried.png'] })
    )
  })

  it('a removed carried image does not start the session', async () => {
    renderForm([
      { path: '/tmp/chat-images/carried.png', name: 'carried.png', url: 'blob:preview' }
    ])
    await userEvent.click(screen.getByRole('button', { name: 'Remove carried.png' }))
    expect(screen.getByRole('button', { name: 'Start session' })).toBeDisabled()
  })
})
