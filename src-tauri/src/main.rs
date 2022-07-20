#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

//the plan: start system clock with main loop
//have a loop polling for RF connection
//time stamp all events

//for front end and even epoch
//during handshake between ground control and rocket, establish what data is
//being sent to what channels, and have the front end generate graphs
//respectively, create a js function that does all of this and
//have some sort of rendering manager to update everything at once
//maybe do this on seperate threads

fn main() {
  println!("starting sundial...");
  println!("entering loop");

  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![greet])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[tauri::command]
fn greet(name: &str) -> String {
   format!("Hello, {}!", name)
}



fn simulate_sitl() -> Result<u8, String> {
  let resolution : f64 = 1./200.;
  let mut time_accum : f64 = 0.;
  let mut current_data : f64 = 0.;

  loop {
    if time_accum > 500. {
      break;
    }
    current_data = time_accum.sin();
    time_accum += resolution;
    println!("data: {}, time: {}", current_data, time_accum);
  }

  Ok(0)
}