const invoke = window.__TAURI__.invoke;

invoke("greet", { name: "World" }).then((response) => console.log(response));

const ctx = document.getElementById("myChart").getContext("2d");
const data = {
  labels: ["a", "b", "c", "d", "e", "f", "g"],
  datasets: [
    {
      label: "My First Dataset",
      data: [65, 59, 80, 81, 56, 55, 40],
      fill: false,
      borderColor: "rgb(75, 192, 192)",
      tension: 0.1,
    },
  ],
};
const config = {
  type: "line",
  data: data,
  options: {
    layout: {
      padding: {
        left: 50,
        right: 50,
      },
    },
  },
};
const myChart = new Chart(ctx, config);

function addData(chart, data) {
  chart.data.labels.push("1");
  chart.data.datasets[0].data.push(1);
  chart.update();
}

addData(myChart, 1);
