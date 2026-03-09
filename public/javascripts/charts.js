/**
 * Bitcoin Supply - Chart Utilities
 * Chart.js initialization and configuration for dark theme
 */

// Configure Chart.js defaults for dark theme
if (typeof Chart !== 'undefined') {
  Chart.defaults.color = '#A3A3A3'; // --text-secondary
  Chart.defaults.borderColor = '#333333'; // --border
  Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  Chart.defaults.plugins.legend.labels.color = '#FFFFFF';
  Chart.defaults.plugins.tooltip.backgroundColor = '#1A1A1A';
  Chart.defaults.plugins.tooltip.borderColor = '#333333';
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleColor = '#FFFFFF';
  Chart.defaults.plugins.tooltip.bodyColor = '#A3A3A3';
}

/**
 * Initialize Supply Progress Donut Chart
 * @param {string} canvasId - ID of the canvas element
 * @param {number} circulatingSupply - Current circulating supply in BTC
 * @param {number} totalSupply - Total expected supply (21 million)
 */
function initSupplyProgressChart(canvasId, circulatingSupply, totalSupply) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const remaining = totalSupply - circulatingSupply;
  const percentReleased = ((circulatingSupply / totalSupply) * 100).toFixed(2);

  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Released', 'Remaining'],
      datasets: [{
        data: [circulatingSupply, remaining],
        backgroundColor: ['#F7931A', '#262626'],
        borderColor: ['#F7931A', '#333333'],
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            padding: 20,
            font: {
              size: 14
            }
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const label = context.label || '';
              const value = context.parsed.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 8
              });
              return label + ': ' + value + ' BTC';
            }
          }
        },
        title: {
          display: true,
          text: percentReleased + '% Released',
          color: '#F7931A',
          font: {
            size: 24,
            weight: 'bold',
            family: "'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace"
          },
          padding: {
            top: 10,
            bottom: 30
          }
        }
      }
    }
  });
}

/**
 * Initialize Loss Timeline Chart
 * @param {string} canvasId - ID of the canvas element
 * @param {Array} lossData - Array of {block, amount, date} objects
 */
function initLossTimelineChart(canvasId, lossData) {
  const ctx = document.getElementById(canvasId);
  if (!ctx || !lossData || lossData.length === 0) return;

  // Sort by block number
  const sortedData = lossData.sort((a, b) => a.block - b.block);

  new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'BTC Lost',
        data: sortedData.map(item => ({
          x: item.block,
          y: item.amount
        })),
        backgroundColor: '#EF4444',
        borderColor: '#EF4444',
        pointRadius: 5,
        pointHoverRadius: 7
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            title: function(context) {
              return 'Block ' + context[0].parsed.x.toLocaleString();
            },
            label: function(context) {
              return context.parsed.y.toFixed(8) + ' BTC Lost';
            }
          }
        },
        title: {
          display: true,
          text: 'Loss Events Over Time',
          color: '#FFFFFF',
          font: {
            size: 18,
            weight: '600'
          },
          padding: {
            top: 10,
            bottom: 20
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: {
            display: true,
            text: 'Block Number',
            color: '#A3A3A3'
          },
          ticks: {
            callback: function(value) {
              return value.toLocaleString();
            }
          },
          grid: {
            color: '#262626'
          }
        },
        y: {
          type: 'logarithmic',
          title: {
            display: true,
            text: 'BTC Lost (log scale)',
            color: '#A3A3A3'
          },
          ticks: {
            callback: function(value) {
              return value.toFixed(2) + ' BTC';
            }
          },
          grid: {
            color: '#262626'
          }
        }
      }
    }
  });
}

/**
 * Initialize Transaction Flow Chart
 * @param {string} canvasId - ID of the canvas element
 * @param {number} inputValue - Total input value
 * @param {number} outputValue - Total output value
 * @param {number} feeValue - Fee value
 */
function initTransactionFlowChart(canvasId, inputValue, outputValue, feeValue) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  const lostValue = inputValue - outputValue - feeValue;

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Inputs', 'Outputs', 'Fees', 'Lost'],
      datasets: [{
        data: [inputValue, outputValue, feeValue, lostValue > 0 ? lostValue : 0],
        backgroundColor: ['#3B82F6', '#10B981', '#F59E0B', '#EF4444'],
        borderColor: ['#3B82F6', '#10B981', '#F59E0B', '#EF4444'],
        borderWidth: 2
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              return context.parsed.x.toFixed(8) + ' BTC';
            }
          }
        },
        title: {
          display: true,
          text: 'Transaction Value Flow',
          color: '#FFFFFF',
          font: {
            size: 18,
            weight: '600'
          }
        }
      },
      scales: {
        x: {
          ticks: {
            callback: function(value) {
              return value.toFixed(4) + ' BTC';
            }
          },
          grid: {
            color: '#262626'
          }
        },
        y: {
          grid: {
            display: false
          }
        }
      }
    }
  });
}

/**
 * Initialize Loss Distribution Histogram
 * @param {string} canvasId - ID of the canvas element
 * @param {Array} lossAmounts - Array of loss amounts
 */
function initLossDistributionChart(canvasId, lossAmounts) {
  const ctx = document.getElementById(canvasId);
  if (!ctx || !lossAmounts || lossAmounts.length === 0) return;

  // Create bins for histogram (logarithmic scale)
  const bins = [
    { label: '< 0.01', min: 0, max: 0.01 },
    { label: '0.01 - 0.1', min: 0.01, max: 0.1 },
    { label: '0.1 - 1', min: 0.1, max: 1 },
    { label: '1 - 10', min: 1, max: 10 },
    { label: '10 - 50', min: 10, max: 50 },
    { label: '> 50', min: 50, max: Infinity }
  ];

  const counts = bins.map(bin => {
    return lossAmounts.filter(amount => amount >= bin.min && amount < bin.max).length;
  });

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: bins.map(b => b.label + ' BTC'),
      datasets: [{
        label: 'Number of Events',
        data: counts,
        backgroundColor: '#EF4444',
        borderColor: '#EF4444',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              return context.parsed.y + ' loss events';
            }
          }
        },
        title: {
          display: true,
          text: 'Loss Distribution',
          color: '#FFFFFF',
          font: {
            size: 18,
            weight: '600'
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: 'Number of Events',
            color: '#A3A3A3'
          },
          grid: {
            color: '#262626'
          }
        },
        x: {
          title: {
            display: true,
            text: 'Loss Amount Range',
            color: '#A3A3A3'
          },
          grid: {
            display: false
          }
        }
      }
    }
  });
}

/**
 * Initialize Block Transaction Loss Chart
 * @param {string} canvasId - ID of the canvas element
 * @param {Array} transactions - Array of {txid, lossAmount} objects
 */
function initBlockLossChart(canvasId, transactions) {
  const ctx = document.getElementById(canvasId);
  if (!ctx || !transactions || transactions.length === 0) return;

  // Only show transactions with losses
  const lossTransactions = transactions.filter(tx => tx.lossAmount > 0);
  if (lossTransactions.length === 0) return;

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: lossTransactions.map(tx => tx.txid.substring(0, 8) + '...'),
      datasets: [{
        label: 'BTC Lost',
        data: lossTransactions.map(tx => tx.lossAmount),
        backgroundColor: '#EF4444',
        borderColor: '#EF4444',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            title: function(context) {
              const fullTx = lossTransactions[context[0].dataIndex];
              return 'TX: ' + fullTx.txid;
            },
            label: function(context) {
              return context.parsed.y.toFixed(8) + ' BTC Lost';
            }
          }
        },
        title: {
          display: true,
          text: 'Losses by Transaction',
          color: '#FFFFFF',
          font: {
            size: 18,
            weight: '600'
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: 'BTC Lost',
            color: '#A3A3A3'
          },
          ticks: {
            callback: function(value) {
              return value.toFixed(4);
            }
          },
          grid: {
            color: '#262626'
          }
        },
        x: {
          grid: {
            display: false
          }
        }
      }
    }
  });
}

// Make functions available globally
if (typeof window !== 'undefined') {
  window.BitcoinSupplyCharts = {
    initSupplyProgressChart,
    initLossTimelineChart,
    initTransactionFlowChart,
    initLossDistributionChart,
    initBlockLossChart
  };
}
