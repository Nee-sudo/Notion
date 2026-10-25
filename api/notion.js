
const NOTION_VERSION = "2022-06-28";
const START_MARKER = "CREATOR_OS_DATA_START";
const END_MARKER = "CREATOR_OS_DATA_END";

function notionHeaders() {
  return {
    Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json"
  };
}

async function notionRequest(path, options = {}) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      ...notionHeaders(),
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.message || `Notion API error: ${response.status}`
    );
  }

  return data;
}

function getTitle(video) {
  return (
    video.title ||
    video.name ||
    video.videoTitle ||
    "Untitled Video Plan"
  ).toString().slice(0, 200);
}

function paragraph(text) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: text } }]
    }
  };
}

function jsonBlocks(video) {
  const json = JSON.stringify(video, null, 2);
  const blocks = [paragraph(START_MARKER)];

  // Notion limits the content of an individual rich-text item.
  // Separate code blocks preserve large JSON payloads.
  const chunkSize = 1800;

  for (let i = 0; i < json.length; i += chunkSize) {
    blocks.push({
      object: "block",
      type: "code",
      code: {
        language: "json",
        rich_text: [
          {
            type: "text",
            text: {
              content: json.slice(i, i + chunkSize)
            }
          }
        ]
      }
    });
  }

  blocks.push(paragraph(END_MARKER));
  return blocks;
}

function blockText(block) {
  const content = block[block.type]?.rich_text || [];
  return content.map(item => item.plain_text || item.text?.content || "")
    .join("");
}

async function getAllChildren(blockId) {
  const results = [];
  let cursor;

  do {
    const query = cursor
      ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
      : "?page_size=100";

    const data = await notionRequest(
      `/blocks/${blockId}/children${query}`
    );

    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  return results;
}

async function deletePreviousPayload(pageId) {
  const blocks = await getAllChildren(pageId);

  let start = -1;
  let end = -1;

  for (let i = 0; i < blocks.length; i++) {
    if (blockText(blocks[i]) === START_MARKER) start = i;
    if (start !== -1 && blockText(blocks[i]) === END_MARKER) {
      end = i;
      break;
    }
  }

  // If no complete marked section exists, preserve the page.
  if (start === -1 || end === -1 || end < start) return;

  for (const block of blocks.slice(start, end + 1)) {
    await notionRequest(`/blocks/${block.id}`, {
      method: "DELETE"
    });
  }
}

async function appendPayload(pageId, video) {
  const blocks = jsonBlocks(video);

  // Append in batches to support large video plans.
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
  const databaseId = process.env.NOTION_DATABASE_ID;

  const page = await notionRequest("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties: {
        Name: {
          title: [
            {
              text: { content: getTitle(video) }
            }
          ]
        }
      }
    })
  });

  await appendPayload(page.id, video);
  return page.id;
}

async function updatePage(pageId, video) {
  // Update the database title.
  await notionRequest(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        Name: {
          title: [
            {
              text: { content: getTitle(video) }
            }
          ]
        }
      }
    })
  });

  // Replace only the payload section managed by this API.
  await deletePreviousPayload(pageId);
  await appendPayload(pageId, video);
}

export default async function handler(req, res) {
  // CORS is needed when the HTML runs on a different origin.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATABASE_ID) {
    return res.status(500).json({
      error: "Missing NOTION_TOKEN or NOTION_DATABASE_ID"
    });
  }

  try {
    const body = req.body || {};
    const { video, pageId } = body;

    if (!video || typeof video !== "object" || Array.isArray(video)) {
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
  } catch (error) {
    console.error("Notion sync failed:", error.message);

    return res.status(500).json({
      error: error.message || "Notion synchronization failed"
    });
  }
}
