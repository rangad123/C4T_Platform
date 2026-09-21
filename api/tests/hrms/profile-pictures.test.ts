import { describe, expect, it } from 'vitest'
import { findPictureFile, pictureMime } from '../../src/lib/hrms/hr-profile-pictures.js'

describe('pictureMime', () => {
  it('knows the image types the app accepts, whatever the case', () => {
    expect(pictureMime('admin.jpg')).toBe('image/jpeg')
    expect(pictureMime('ADMIN.JPEG')).toBe('image/jpeg')
    expect(pictureMime('07_05_21_04_05_49__18.png')).toBe('image/png')
    expect(pictureMime('a.webp')).toBe('image/webp')
    expect(pictureMime('a.gif')).toBe('image/gif')
  })

  it('refuses anything that is not a picture', () => {
    expect(pictureMime('cv.pdf')).toBeNull()
    expect(pictureMime('notes')).toBeNull()
    expect(pictureMime('archive.zip')).toBeNull()
  })
})

describe('findPictureFile', () => {
  const folder = ['admin.jpg', 'Photo_18.PNG', 'other.png']

  it('finds the exact name', () => {
    expect(findPictureFile(folder, 'admin.jpg')).toBe('admin.jpg')
  })

  it('finds it when copying changed the case', () => {
    expect(findPictureFile(folder, 'photo_18.png')).toBe('Photo_18.PNG')
  })

  it('prefers an exact match over a different-case one', () => {
    expect(findPictureFile(['A.jpg', 'a.jpg'], 'a.jpg')).toBe('a.jpg')
  })

  it('reports a file that is not there as missing', () => {
    expect(findPictureFile(folder, 'nobody.jpg')).toBeNull()
  })
})
