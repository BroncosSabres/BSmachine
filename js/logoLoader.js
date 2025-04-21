// logoLoader.js

export async function loadTeamLogos(data, logoPath = '../logos') {
    const logos = {};
    const loadPromises = data.filter(team => team && team["Team"]).map(team => {
      const name = team["Team"].toLowerCase();
      return new Promise(resolve => {
        const img = new Image();
        img.src = `${logoPath}/${name}.svg`;
        img.onload = () => {
          console.log(`Loaded logo for ${team["Team"]}`);
          logos[team["Team"]] = img;
          resolve();
        };
        img.onerror = () => {
          console.warn(`Failed to load logo for ${team["Team"]}`);
          resolve();
        };
      });
    });
    await Promise.all(loadPromises);
    return logos;
  }
  