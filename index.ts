import axios from 'axios';
import * as dotenv from 'dotenv';
import * as dayjs from 'dayjs';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as _ from 'lodash';
import { Browser, launch, Page } from 'puppeteer';

dotenv.config();
const config = yaml.safeLoad(fs.readFileSync('twins-rss.config.yaml', 'utf-8'));

// Puppeteer で使う DOM のセレクタ
const selectors = {
  userName: '#LoginFormSlim input[name=userName]',
  password: '#LoginFormSlim input[name=password]',
  submit: '#LoginFormSlim button[type="submit"]',
  loginWait: '#main_information_menu',
  newsTab: '#tab-kj',
  newsTabWait: '#main-frame-div .portlet-title',
  genreList: 'ul.genre-list > li',
  newsFrameName: 'portlet-body',
  newsDisplayCount: 'form[name=PagingForm] select[name="_displayCount"]',
  newsDisplayCountButton: 'form[name=PagingForm] input[type=submit]',
  newsHeaderTh: 'table.normal > thead > tr > th',
  newsBodyTr: 'table.normal > tbody > tr',
};

(async () => await main())();

async function main() {
  const browser = await launch({ headless: !config.debug });
  try {
    const page = await getPageWithLogin(browser);
    await gotoNewsTab(page);
    const genres = await getGenreList(page);
    for (const genre of genres) {
      if (config.ignore_genres.includes(genre.name)) {
        continue;
      }
      const newsList = (await getNewsList(page, genre)).filter(newsDaysFilter);

      if (config.notify_by.includes('slack')) {
        for (const news of newsList) {
          await sendSlackWebhook(news);
        }
      }
    }
  } finally {
    if (!config.debug) {
      await browser.close();
    }
  }
}

// ニュースの掲載日によるフィルタ
function newsDaysFilter(news: any): boolean {
  const sinceDays = config.notify_since_days;
  if (sinceDays === -1) {
    // -1 のときはすべてのニュースを受理する。
    return true;
  }

  const newsDate = dayjs(dayjs(news.掲載日時).format('YYYY-MM-DD'));
  const limitDate = dayjs(dayjs().format('YYYY-MM-DD'))
    .subtract(config.notify_since_days, 'day')
    .subtract(1, 'second');
  return newsDate.isAfter(limitDate);
}

// ログイン済みの Page オブジェクトを取得する
async function getPageWithLogin(browser: Browser) {
  const page = await browser.newPage();
  await page.goto(process.env.BASE_URL);
  await page.waitFor(selectors.password);
  await page.type(selectors.userName, process.env.ID);
  await page.type(selectors.password, process.env.PASSWORD);
  await page.click(selectors.submit);
  await page.waitFor(selectors.loginWait);
  return page;
}

// 「掲示」タブに移動する
async function gotoNewsTab(page: Page) {
  await page.click(selectors.newsTab);
  await page.waitFor(selectors.newsTabWait);
}

interface Genre {
  name: string;
  count: number;
  linkScript: string;
}

// 掲示のジャンル情報を取得する
// ref. https://twins.tsukuba.ac.jp/campusweb/campusportal.do?page=main&tabId=kj
async function getGenreList(page: Page) {
  const genres: Genre[] = [];
  const genreHandlers = await page.$$(selectors.genreList);
  for (const genreHandler of genreHandlers) {
    const [genreName, onclickHandlerString] = await genreHandler.evaluate(
      li => [
        li
          .querySelector('div')
          .textContent.trim()
          .replace(/[\n\s]/g, ''),
        li.querySelector('.right > a').getAttribute('onclick'),
      ]
    );
    const [, name, countString] = /(.+?)[（/].+\((\d+)件\)/.exec(genreName);
    const count = Number(countString);
    const linkScript = onclickHandlerString;
    genres.push({ name, count, linkScript });
  }
  return genres;
}

// 指定したジャンルの最新200件のニュース一覧を取得する
async function getNewsList(page: Page, genre: Genre) {
  const { name: genreName, count, linkScript } = genre;
  if (count === 0) {
    return [];
  }

  await page.evaluate(linkScript);
  await page.waitFor(1000);

  const frame = (await page.frames()).find(frame => {
    return frame.name() === selectors.newsFrameName;
  });
  await frame.select(selectors.newsDisplayCount, '200');
  await frame.click(selectors.newsDisplayCountButton);
  await page.waitFor(1000);

  const newFrame = (await page.frames()).find(
    frame => frame.name() === selectors.newsFrameName
  );
  await newFrame.waitFor(selectors.newsDisplayCountButton);

  const newsHeaders = await newFrame.$$eval(selectors.newsHeaderTh, ths =>
    ths.map(th => th.textContent.trim())
  );

  const newsRows = await newFrame.$$(selectors.newsBodyTr);
  const newsList = [];
  for (const newsRow of newsRows) {
    const newsRowTexts = await newsRow.$$eval('td', tds =>
      tds.map(td => td.textContent.trim())
    );
    const news = {};
    for (const [newsHeader, newsRowText] of _.zip(newsHeaders, newsRowTexts)) {
      news[newsHeader] = newsRowText;
    }
    news['ジャンル'] = genreName;
    news['掲示期間'] = news['掲示期間'].replace(/\s|\n/g, '');
    newsList.push(news);
  }
  return newsList;
}

// 1つのニュースについて Slack に Webhook で通知を送る
async function sendSlackWebhook(news: any) {
  const title = `[${news.ジャンル}] ${news.表題}`;
  const icon_emoji =
    config.genre_emoji_map[news.ジャンル] ?? config.genre_emoji_map.default;
  delete news.ジャンル;
  delete news.表題;
  const body = convertToReadableText(news);
  const payload = {
    icon_emoji,
    text: body,
    username: title,
  };

  await axios.post(process.env.WEBHOOK_URL, payload, {
    headers: { 'content-type': 'application/json' },
  });
}

// Slack 通知で読みやすいように変換する
function convertToReadableText(news: any): string {
  return Object.entries(news)
    .map(([key, value]) => `*${key}* | ${value}`)
    .join('\n');
}
