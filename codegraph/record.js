const puppeteer = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');

(async () => {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1280, height: 800 } });
    const page = await browser.newPage();

    console.log('Starting recording...');
    const recorder = new PuppeteerScreenRecorder(page);
    await recorder.start('./demo.mp4');

    try {
        console.log('Navigating to http://localhost:3000...');
        await page.goto('http://localhost:3000', { waitUntil: 'networkidle2' });

        // Wait for initial render
        await page.waitForTimeout(2000);

        // Feature 1: Explorer search
        console.log('Typing in Explorer...');
        await page.type('#explorer-search', 'torque', { delay: 100 });
        await page.waitForTimeout(1000);
        await page.keyboard.press('Enter');

        // Let graph load and animations complete
        await page.waitForTimeout(4000);

        // Click "Depended on by"
        console.log('Switching direction in Explorer...');
        const dependentBtn = await page.$('button[data-direction="dependents"]');
        if (dependentBtn) await dependentBtn.click();
        await page.waitForTimeout(3000);

        // Feature 2: Risk Radar
        console.log('Switching to Risk Radar...');
        const riskTab = await page.$('button[data-tab="risk"]');
        if (riskTab) await riskTab.click();
        await page.waitForTimeout(3000);

        // Feature 3: Compare
        console.log('Switching to Compare...');
        const compareTab = await page.$('button[data-tab="compare"]');
        if (compareTab) await compareTab.click();
        await page.waitForTimeout(1000);

        console.log('Typing packages to compare...');
        await page.type('#compare-a', 'torque-cli', { delay: 100 });
        await page.type('#compare-b', 'wick-migrate', { delay: 100 });
        await page.click('#compare-run');
        await page.waitForTimeout(3000);

    } catch (err) {
        console.error('Error during recording:', err);
    } finally {
        console.log('Stopping recording and closing browser...');
        await recorder.stop();
        await browser.close();
        console.log('Saved recording to demo.mp4');
    }
})();
