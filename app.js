const _ = require('lodash');
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const neo4j = require('neo4j-driver');
const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));


// Delete all nodes and relationship
function deleteAll(tx) {
  return tx.run(
    `MATCH (n) DETACH DELETE n`
  );
}

function getOrdersCount(tx) {
  return tx.run(
    `MATCH (o:Order) RETURN count(o)`
  );
}

// Add items and create relationship between order and items
function addItems(tx, orderJsonPath) {
  return tx.run(
    `WITH "${orderJsonPath}" AS url
     CALL apoc.load.json(url) YIELD value AS order
     CREATE (o:Order)
     FOREACH(item IN order.lineItems| MERGE(i:Item {itemId : item.itemId}) 
     MERGE(o)-[:ORDERED]->(i))
     RETURN order`
  );
}

// Create relationship between items ordered together
function itemsOrderedTogether(tx) {
  return tx.run(
    `MATCH(o:Order)-[:ORDERED]->(i:Item) 
    WITH o as order, collect(i) as itemsInOrder 
    CALL apoc.nodes.link(itemsInOrder, 'ORDERED_TOGETHER')
    RETURN order, itemsInOrder`
  );
}

async function getRecommendedItems(req, res) {
  const driver = neo4j.driver('bolt://localhost', neo4j.auth.basic('neo4j', 'kishore12'));
  // const driver = neo4j.driver('bolt://54.90.11.116:34259', neo4j.auth.basic('neo4j', 'rope-inches-movements'));
  let { numRecommendations = 5, 
        thresholdPercent = 0, 
        isRemotePath = false, 
        minOrderCount = 1000,
        minItemOrderedCount = 0,
        orderJsonPath } = req.body;
  const session = driver.session();

  try {
    await driver.verifyConnectivity();
    console.log('Driver created');
  } catch (error) {
    console.log(`connectivity verification failed. ${error}`);
    res.send({ error: error });
  }

  try {
    if (orderJsonPath) {
      orderJsonPath = isRemotePath ? orderJsonPath : `file:${orderJsonPath}`;

      await session.writeTransaction(tx => deleteAll(tx));

      await session.writeTransaction(tx => addItems(tx, orderJsonPath));

      await session.writeTransaction(tx => itemsOrderedTogether(tx));
    }

    const orderCountResult = await session.readTransaction(tx => getOrdersCount(tx));

    if(_.get(orderCountResult, 'records[0]._fields[0].low', 0) > minOrderCount) {
      const result = await session.readTransaction(tx =>
        tx.run(`MATCH (item:Item)-[:ORDERED]-(o:Order) 
                WITH DISTINCT item as item1, count(item) as noOfItemOrdered
                MATCH (item1)-[:ORDERED_TOGETHER]-(item2:Item)
                WITH
                  item1.itemId as itemId1,
                  item2.itemId as itemId2,
                  100.0 * count(item1)/noOfItemOrdered AS approximatePercent,
                  noOfItemOrdered
                  
                WHERE approximatePercent > ${thresholdPercent} AND noOfItemOrdered > ${minItemOrderedCount}
                WITH itemId2 AS recommendedItem, approximatePercent, itemId1
                ORDER BY approximatePercent DESC
                RETURN itemId1, collect(recommendedItem)[..${numRecommendations}]`
        ));

      const recommendedItems = result.records.reduce((recommendedItem, record) => (recommendedItem[record._fields[0]] = record._fields[1], recommendedItem), {});
      res.send(recommendedItems);
    } else {
      res.send({message: `Order count must be greater ${minOrderCount}`});
    }
  } catch (error) {
    console.log(`Query exceution failed. ${error}`);
    res.send({ error: error });
  } finally {
    await session.close();
  }
}

app.get('/recommendItems', getRecommendedItems);

app.listen(3000);
console.log('Server started on port 3000');
