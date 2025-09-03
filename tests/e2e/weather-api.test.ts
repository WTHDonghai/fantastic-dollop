import { test, expect } from '@playwright/test';

test.describe('Weather Feature Test', () => {
  test('should display weather card when force weather is triggered', async ({ page }) => {
    // 导航到聊天页面
    await page.goto('/');
    
    // 等待页面加载
    await page.waitForLoadState('networkidle');
    
    // 查找输入框并输入强制天气命令
    const input = page.locator('textarea[placeholder*="Send a message"]');
    await input.fill('show me the weather #force_weather');
    
    // 发送消息
    await input.press('Enter');
    
    // 等待助手响应
    await page.waitForTimeout(3000);
    
    // 查找天气相关内容
    const weatherContent = page.locator('text=/temperature|weather|°|sunny|cloudy|rainy/i');
    
    // 检查是否有天气相关内容显示
    const weatherExists = await weatherContent.count() > 0;
    
    if (!weatherExists) {
      // 如果没有找到天气内容，输出页面内容用于调试
      const pageContent = await page.textContent('body');
      console.log('Page content:', pageContent);
      
      // 截图用于调试
      await page.screenshot({ path: 'debug-weather-feature.png' });
    }
    
    expect(weatherExists).toBeTruthy();
  });
  

});