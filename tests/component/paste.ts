import { fireEvent } from '@testing-library/react'

/** A React-testing paste event carrying one image file, jsdom-style. */
export function pasteImage(el: Element, file: File): void {
  fireEvent.paste(el, {
    clipboardData: {
      items: [{ kind: 'file', type: file.type, getAsFile: () => file }]
    }
  })
}

/** jsdom has no object URLs — tests stub both ends before rendering a composer. */
export function stubObjectUrls(): void {
  URL.createObjectURL = () => 'blob:preview'
  URL.revokeObjectURL = () => {}
}
