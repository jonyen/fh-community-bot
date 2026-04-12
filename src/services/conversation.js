export function createConversationService(docClient, tableName) {
  async function getConversation(pk) {
    const result = await docClient.get({ TableName: tableName, Key: { pk } });
    return result.Item ?? null;
  }

  async function saveConversation(pk, data) {
    const ttl = Math.floor(Date.now() / 1000) + 86400;
    const updatedAt = new Date().toISOString();
    await docClient.put({
      TableName: tableName,
      Item: { pk, ...data, ttl, updatedAt },
    });
  }

  async function deleteConversation(pk) {
    await docClient.delete({ TableName: tableName, Key: { pk } });
  }

  return { getConversation, saveConversation, deleteConversation };
}
