const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { Cluster } = require("puppeteer-cluster");
const cors = require("cors");

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json()); // Middleware to parse JSON request body

// Unrestricted CORS Configuration
app.use(cors()); // Allows all origins, methods, and headers

const scrapeData = async (googleScholarUrl) => {
  try {
    const returnText = async (textPage, selector) => {
      try {
        const element = await textPage.$(selector);
        if (element) {
          const elementText = await textPage.evaluate(
            (el) => el.innerText,
            element
          );
          return elementText.trim();
        } else {
          console.error(`Element not found for selector: ${selector}`);
          return "";
        }
      } catch (error) {
        console.error(`Error getting text for selector ${selector}:`, error);
        return "";
      }
    };

    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
    );

    await page.goto(googleScholarUrl);

    async function getScholarlyLiterature(elements) {
      let list_of_publications = [];
      for (let element of elements) {
        const anchor = await page.evaluate((el) => el.href, element);
        list_of_publications.push(anchor);
      }
      return list_of_publications;
    }

    const buttonSelector = "#gsc_bpf_more";

    async function clickShowMoreButton() {
      try {
        const button = await page.$(buttonSelector);
        if (button) {
          await button.click();
          await page.waitForFunction(
            (selector) => {
              const btn = document.querySelector(selector);
              return btn && !btn.disabled;
            },
            { timeout: 2000 },
            buttonSelector
          );
          await clickShowMoreButton();
        }
      } catch (error) {}
    }

    await clickShowMoreButton();

    const nameSelector = "#gsc_prf_in";
    const uniNameSelector = ".gsc_prf_ila";
    const noOfCitationsSelector =
      "#gsc_rsb_st > tbody > tr:nth-child(1) > td:nth-child(2)";
    const hIndexSelector =
      "#gsc_rsb_st > tbody > tr:nth-child(2) > td:nth-child(2)";
    const publicationsSelector = "td.gsc_a_t > a";

    const name = await returnText(page, nameSelector);
    const uniName = await returnText(page, uniNameSelector);
    const noOfCitations = await returnText(page, noOfCitationsSelector);
    const hIndex = await returnText(page, hIndexSelector);

    const publications = await page.$$(publicationsSelector);
    const publicationsUrl = await getScholarlyLiterature(publications);

    const facultyDetails = {
      name,
      uniName,
      noOfCitations,
      hIndex,
      noOfPublications: publicationsUrl.length,
    };

    const cluster = await Cluster.launch({
      puppeteer,
      concurrency: Cluster.CONCURRENCY_PAGE,
      maxConcurrency: 5,
      puppeteerOptions: { headless: false },
    });

    const publicationDetailsArray = [];

    await cluster.task(async ({ page, data: url }) => {
      try {
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.87 Safari/537.36"
        );
        await page.goto(url);

        const titleSelector = "#gsc_oci_title";
        await page.waitForSelector(titleSelector);

        let publicationDetails = {};
        publicationDetails["type"] = null;

        const publicationUrlElement = await page.$(titleSelector);
        publicationDetails["publicationUrls"] = await page.evaluate(
          (el) => el.querySelector("a")?.href || null,
          publicationUrlElement
        );

        publicationDetails["publicationTitle"] = await page.evaluate(
          (el) => el.innerText,
          publicationUrlElement
        );

        const publicationsDetailsSelector = "#gsc_oci_table > div.gs_scl";
        const publicationsDetailsElements = await page.$$(
          publicationsDetailsSelector
        );

        for (let publicationDetail of publicationsDetailsElements) {
          const title = await publicationDetail.evaluate(
            (el) => el.querySelector("div.gsc_oci_field")?.innerText || "",
            publicationDetail
          );

          const description = await publicationDetail.evaluate(
            (el) => el.querySelector("div.gsc_oci_value")?.innerText || ""
          );

          if (title && description) {
            publicationDetails[title] = description;
            if (title === "Conference") {
              publicationDetails["type"] = "Conference";
            } else if (title === "Journal") {
              publicationDetails["type"] = "Journal";
            } else if (title === "Book") {
              publicationDetails["type"] = "Book";
            }
          }
        }

        if (!publicationDetails["type"]) {
          publicationDetails["type"] = "Unknown";
        }

        publicationDetailsArray.push(publicationDetails);
      } catch (error) {
        console.error(`Error processing URL ${url}:`, error);
      }
    });

    for (let url of publicationsUrl) {
      cluster.queue(url);
    }

    await cluster.idle();
    await cluster.close();
    await browser.close();

    return { facultyDetails, publicationDetailsArray };
  } catch (error) {
    console.error("Error during Puppeteer script execution:", error);
    throw error;
  }
};

app.get("/api", async (req, res) => {
  const googleScholarUrl = req.query.url;

  if (!googleScholarUrl) {
    return res.status(400).json({ error: "Google Scholar URL is required" });
  }

  const googleScholarRegex =
    /^https:\/\/scholar\.google\.com\/citations\?user=/;
  if (!googleScholarRegex.test(googleScholarUrl)) {
    return res.status(400).json({
      error: "Invalid URL format. Please provide a valid Google Scholar URL.",
    });
  }

  try {
    const data = await scrapeData(googleScholarUrl);
    return res.json({
      success: true,
      message: "Data successfully scraped",
      data: data,
    });
  } catch (error) {
    console.error("Error during scraping:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to scrape data",
      details: error.message,
    });
  }
});

app.listen(8000, () => {
  console.log("Server started on port 8000");
});