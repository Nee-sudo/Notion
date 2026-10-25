
const NOTION_VERSION = "2022-06-28";
const START_MARKER = "CREATOR_OS_DATA_START";
const END_MARKER = "CREATOR_OS_DATA_END";

function headers() {
  return {
    Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json"
  };
}

async function notionRequest(path, options = {}) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.message || `Notion API error: ${response.status}`
    );
  }

  return data;
}

function titleOf(video) {
  return String(
    video?.title ||
    video?.name ||
    video?.idn?.final ||
    video?.idn?.working ||
    "Untitled Video Plan"
  ).slice(0, 200);
}

function textBlock(text) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: text } }]
    }
  };
}

function makePayloadBlocks(video) {
  const json = JSON.stringify(video, null, 2);
  const blocks = [textBlock(START_MARKER)];

  for (let i = 0; i < json.length; i += 1800) {
    blocks.push({
      object: "block",
      type: "code",
      code: {
        language: "json",
        rich_text: [{
          type: "text",
          text: { content: json.slice(i, i + 1800) }
        }]
      }
    });
  }

  blocks.push(textBlock(END_MARKER));
  return blocks;
}

function blockText(block) {
  return (block[block.type]?.rich_text || [])
    .map(item => item.plain_text || item.text?.content || "")
    .join("");
}

async function getChildren(blockId) {
  const results = [];
  let cursor;

  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);

    const data = await notionRequest(
      `/blocks/${blockId}/children?${query}`
    );

    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  return results;
}

async function deleteManagedPayload(pageId) {
  const blocks = await getChildren(pageId);
  const start = blocks.findIndex(
    block => blockText(block) === START_MARKER
  );

  if (start < 0) return;

  const end = blocks.findIndex(
    (block, index) =>
      index > start && blockText(block) === END_MARKER
  );

  // Preserve existing content if the payload markers are incomplete.
  if (end < 0) return;

  for (const block of blocks.slice(start, end + 1)) {
    await notionRequest(`/blocks/${block.id}`, {
      method: "DELETE"
    });
  }
}

async function appendPayload(pageId, video) {
  const blocks = makePayloadBlocks(video);

  for (let i = 0; i < blocks.length; i += 100) {
    await notionRequest(`/blocks/${pageId}/children`, {
      method: "PATCH",
      body: JSON.stringify({
        children: blocks.slice(i, i + 100)
      })
    });
  }
}

async function createPage(video) {
  const page = await notionRequest("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: {
        database_id: process.env.NOTION_DATABASE_ID
      },
      properties: {
        Name: {
          title: [{
            text: { content: titleOf(video) }
          }]
        }
      }
    })
  });

  await appendPayload(page.id, video);
  return page.id;
}

async function updatePage(pageId, video) {
  await notionRequest(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        Name: {
          title: [{
            text: { content: titleOf(video) }
          }]
        }
      }
    })
  });

  await deleteManagedPayload(pageId);
  await appendPayload(pageId, video);
}

async function loadPlans() {
  const databaseId = process.env.NOTION_DATABASE_ID;
  const results = [];
  let cursor;

  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const data = await notionRequest(
      `/databases/${databaseId}/query`,
      {
        method: "POST",
        body: JSON.stringify(body)
      }
    );

    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  const plans = [];

  for (const page of results) {
    const blocks = await getChildren(page.id);
    const start = blocks.findIndex(
      block => blockText(block) === START_MARKER
    );

    if (start < 0) continue;

    const end = blocks.findIndex(
      (block, index) =>
        index > start && blockText(block) === END_MARKER
    );

    if (end < 0) continue;

    const json = blocks.slice(start + 1, end)
      .map(block => blockText(block))
      .join("");

    try {
      const video = JSON.parse(json);
      plans.push({
        video,
        pageId: page.id
      });
    } catch {
      // Skip malformed payloads; continue loading other pages.
    }
  }

  return plans;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (!process.env.NOTION_TOKEN ||
      !process.env.NOTION_DATABASE_ID) {
    return res.status(500).json({
      error: "Missing NOTION_TOKEN or NOTION_DATABASE_ID"
    });
  }

  try {
    if (req.method === "GET") {
      const plans = await loadPlans();
      return res.status(200).json({
        success: true,
        plans
      });
    }

    if (req.method === "POST") {
      const { video, pageId } = req.body || {};

      if (!video || typeof video !== "object" ||
          Array.isArray(video)) {
        return res.status(400).json({
          error: "A video object is required"
        });
      }

      const savedPageId = pageId
        ? (await updatePage(pageId, video), pageId)
        : await createPage(video);

      return res.status(200).json({
        success: true,
        pageId: savedPageId
      });
    }

    return res.status(405).json({
      error: "Method not allowed"
    });
  } catch (error) {
    console.error("Notion API error:", error.message);

    return res.status(500).json({
      error: error.message || "Notion API request failed"
    });
  }
}
