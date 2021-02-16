# bitcoin-supply.com

This is the codebase behind the bitcoin-supply.com website. It shows how the
supply calculations are reached and serves as a platform for proposals and
debate about changes to these calculations. Primarily, this site tracks *provably
lost* coin although *likely lost* and other classifications are possible.

Coin can be *provably lost* by users issuing transactions which require an
impossible condition for re-spend. (akin to requiring 1 + 1 = 3 before a coin
can be spent again) Coins can also be *provably lost* by miners not accepting
the expected new supply in a block (not accepting the block reward) or by not
collecting the existing coins which are available to the miners as fees for
the transactions in blocks.

Coin classified as *likely lost*, as its name would imply, is a more subjective
label. This include coins that are likely unspendable due to the loss of
private keys. While this type of loss can never be proven, it is still a useful
estimation.

## Contributions

Additions and changes to what constitutes *provably lost*, *likely lost* and
other classifications of the supply are done in the [proposals/](proposals/)
tree. Submit a PR with your proposal file in markdown format and discussion
will happen in comments related to the PR. Once proposals reach finality, they
get implemented in the [detectors/](detectors/index.js) and become part of the
production environment.

## Layout

There are three significant parts of this codebase:
* [Proposals](proposals/) and the [logic](detectors/index.js) which implements them
* A [backend](backend-etl.js) script that uses a bitcoin full node to keep the database up to date
* A [website](routes/index.js) which exposes the data in the database

The following instructions will get the backend and web projects up and running
on your system.

### Prerequisites

* Node.js
* PostgreSQL
* Indexed Bitcoin Full Node (with RPC configured and the `-txindex` flag)
* (optional) Google BigQuery account with JSON credential file
* bitcoin-etl (python based - `pip install bitcoin-etl`)

### Installing

Clone the repo:

```
git clone https://github.com/anders94/bitcoin-supply.com.git
```

Enter the directory and install modules:

```
cd bitcoin-supply.com/
npm install
```

Optionally, globally install `db-migrate` so the tool is available at a default path in your shell.
```
npm install -g db-migrate
```

Set up a user and a few databases in your PostgreSQL setup:

```
CREATE USER bitcoin-supply WITH PASSWORD '<change me>';
CREATE DATABASE "bitcoin-supply_dev" OWNER "bitcoin-supply";
CREATE DATABASE "bitcoin-supply_test" OWNER "bitcoin-supply";
CREATE DATABASE "bitcoin-supply_prod" OWNER "bitcoin-supply";
```

Adjust `database.json` specifying your PostgreSQL host, port, username and databases.

Run all the database migrations:
```
db-migrate up
```

Optionally, to walk backwards taking the migrations down one by one, use:
```
db-migrate down
```

## Running
A complete system requires running both the website and the backend process which
updates the database as new blocks come in.

Sync the database from a large BigQuery download: (costly but far quicker than using
RPC on a full node)

```
node backend-bigquery
```

On an ongoing basis, run the RPC based backend to keep website synced with the bitcoin
blockchain.

```
node backend-rpc
```

Start the webserver:
```
node bin/www
```

Point your web browser to `http://localhost:3000`.

## Authors

* **Anders Brownworth** - *Initial work* - [anders94](https://github.com/anders94)

## License

This project is under the MIT License.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
