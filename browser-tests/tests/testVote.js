require("chromedriver");

const { env } = require("process");
const { Builder, By, Key,Capabilities, until } = require("selenium-webdriver");
var assert = require("chai").assert;

//describe - describes test
describe("cast a vote", function () {
  //it - describes expected behaviour
  it("should add a note and display on the page", async function () {
       /*Selenium automates:
      1. Open Chrome
      2. Navigate to app
      3. Type "Hello Selenium" in input box
      4. Clicks the Enter key
     */

      let voteUrl = process.env.URL_VOTE || "https://google.com";
      let resultUrl = process.env.URL_RESULT || "https://google.com";
      console.log("URL_VOTE: " + voteUrl);


      const chromeCapabilities = Capabilities.chrome();
// chromeCapabilities.set('browserless:token', 'YOUR-API-TOKEN');
chromeCapabilities.set('goog:chromeOptions', {
  args: [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-component-extensions-with-background-pages',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-features=TranslateUI,BlinkGenPropertyTrees',
    '--disable-ipc-flooding-protection',
    '--disable-renderer-backgrounding',
    '--enable-features=NetworkService,NetworkServiceInProcess',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
    '--metrics-recording-only',
    '--mute-audio',
    '--headless',
    '--no-sandbox',
  ],
});


       //Chai asserts if new note's text matches the input
	  //
        //open Chrome browser
        //let ulr = process.env.URL_VOTE || "https://google.com";
        console.log("URL_VOTE: " + voteUrl);

        try {

        

        
        var driver;
        // Define the number of clicks
        const numberOfClicks = 5;
        for (let i = 0; i < numberOfClicks; i++) {
            //open the website
            driver = await new Builder().forBrowser("chrome")
                // .usingServer('http://localhost:3000/webdriver')
                .usingServer(env.CHROME_URL || 'http://localhost:3000/webdriver')
                .withCapabilities(chromeCapabilities)
                .build();
            await driver.get(voteUrl);
            console.log("Clicking button");
            await driver.findElement(By.xpath('//button[@id="a"]')).click();
            // Optionally, add a wait or assertion here if needed to verify the click's effect
            // Example: wait for some condition to be true
            // await driver.wait(someCondition, 1000);
            // await driver.findElement(By.xpath('//button[@id="a"]'));
        }
        
        
        
        
        console.log("RESULT_VOTE: " + resultUrl);
        
        await driver.get(resultUrl);
        await driver.wait(until.elementLocated(By.xpath('//html/body/div[3]/span')), 10000);

        let votes = await driver
            .findElement(By.xpath('//html/body/div[3]/span'))
            // /html/body/div[3]/span
            // .getAttribute("innerHTML");
            .getText();

        console.log("votes: " + votes);
        //assert that the note's text is the same as the input text "Hello Selenium"
        assert.equal(votes, numberOfClicks + " votes");
        console.log("TEST PASSED");
        } finally {
        //close the browser
        await driver.quit();
        }

  })
})