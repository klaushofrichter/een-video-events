import { test, expect } from '@playwright/test'

const TEST_USER = process.env.TEST_USER!
const TEST_PASSWORD = process.env.TEST_PASSWORD!

test.describe('EEN Video App', () => {
  test('shows login prompt when not authenticated', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('log in')).toBeVisible()
  })

  test('full login flow, camera dropdown, and live video', async ({ page }) => {
    // Go to home page and click login
    await page.goto('/')
    await page.getByRole('link', { name: 'Login' }).click()

    // Should redirect to EEN OAuth page
    await page.waitForURL(/auth.eagleeyenetworks.com|id\.eagleeyenetworks\.com/, { timeout: 15000 })

    // EEN login is a two-step flow: email first, then password
    await page.getByPlaceholder(/email/i).fill(TEST_USER)
    await page.getByRole('button', { name: /next/i }).click()

    // Wait for password field to appear
    await page.getByPlaceholder(/password/i).fill(TEST_PASSWORD, { timeout: 15000 })
    await page.getByRole('button', { name: /sign in|log in|submit|next/i }).click()

    // Wait for redirect back to our app after OAuth callback
    await page.waitForURL('http://127.0.0.1:3333/**', { timeout: 30000 })

    // Should be authenticated - check for logout button
    await expect(page.getByRole('button', { name: /logout/i })).toBeVisible({ timeout: 15000 })

    // Camera dropdown should appear
    const cameraSelect = page.locator('#camera-select')
    await expect(cameraSelect).toBeVisible({ timeout: 15000 })

    // Should have at least one camera option
    await expect(cameraSelect).not.toBeEmpty()
    const count = await cameraSelect.locator('option').count()
    expect(count).toBeGreaterThan(0)

    // Video element should appear (live stream container)
    const videoElement = page.locator('video')
    await expect(videoElement).toBeVisible({ timeout: 20000 })

    // Test camera switching if there are multiple cameras
    if (count > 1) {
      const secondOptionValue = await cameraSelect.locator('option').nth(1).getAttribute('value')
      await cameraSelect.selectOption(secondOptionValue!)
      // Video should still be visible after switch
      await expect(videoElement).toBeVisible({ timeout: 20000 })
    }

    // Test logout
    await page.getByRole('button', { name: /logout/i }).click()
    await expect(page.getByText('log in')).toBeVisible({ timeout: 10000 })
  })
})
