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
the transactions in a block.

Coin classified as *likely lost*, as its name would imply, is a more subjective
label. This include coins that are likely unspendable due to the loss of
private keys. While this type of loss can never be proven, it is still a useful
estimation. (not currently shown)

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

* git
* (optional) git-lfs
* Node.js
* PostgreSQL
* Indexed Bitcoin Full Node (with RPC configured and the `-txindex` flag)
* bitcoin-etl (python based - `pip install bitcoin-etl`)

### Installing

Clone the repo:

```
git clone https://github.com/anders94/bitcoin-supply.com.git
cd bitcoin-supply.com/
```

Optionally, pull the large SQL files used in backfill: (these are stored in LFS because they are hundreds of megabytes)

```
git lfs pull
```

Install modules:

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

Optionally, to step backwards taking the migrations down migration by migration, use:
```
db-migrate down
```

## Environment Variables
A quick peek at `config/index.js` reveales a set of defaults and environment variables.

Variable | Default
---------|--------
PGHOST | localhost
PGDATABASE | bitcoin-supply_dev
PGUSER | bitcoin-supply
PGPASSWORD | supersecretpassword
RPCHOST | 127.0.0.1
RPCPORT | 8332
RPCNETWORK | mainnet
RPCUSERNAME | rpcuser
RPCPASSWORD | supersecretpassword

Both the webserver and the backend rely on the same environment variables so sourcing a
file or using a tool like `chpst` is convenient. `env/` is in `.gitignore`.

## Running
Start the backend process which updates the database as new blocks come in.

```
node backend-etl
```
Starting from a blank database will take at least a month to catch up to current as the
backend steps through each block one by one running the loss detection logic. Using the
backfill mentioned above significantly reduces this overhead.

Then, start the webserver:
```
node bin/www
```

Point your web browser at `http://localhost:3000` to see the frontend.

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
