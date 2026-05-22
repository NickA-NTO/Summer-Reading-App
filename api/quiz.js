// AI-generated reading comprehension quiz. Generates a POOL of 8 multiple-
// choice questions per book and caches them in Redis. The client picks 4 at
// random per attempt and shuffles the answer options, so a kid retaking the
// quiz sees mostly different questions and never the same option ordering.
//
// Auth: requires a valid rs_session cookie. Middleware excludes /api/* so
// each endpoint does its own check.

import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { verifySession, parseCookies } from "../lib/session.js";
import {
  getCachedQuiz,
  setCachedQuiz,
  guessGradeFromEmail,
} from "../lib/store.js";
import { normalizeGrade } from "../lib/xp.js";

// Canonical book metadata for quiz generation. Summary is what Claude uses
// to generate the 12-question pool; it should be detailed enough that good
// comprehension questions can be drawn from concrete plot beats.
const QUIZ_BOOKS = {
  /* ---------- Grade K ---------- */
  k01: {
    title: "The Very Hungry Caterpillar",
    author: "Eric Carle",
    grade: "K",
    summary:
      "A tiny caterpillar hatches from an egg and eats his way through one apple on Monday, two pears on Tuesday, three plums on Wednesday, four strawberries on Thursday, and five oranges on Friday. On Saturday he eats through a huge feast of junk food including chocolate cake, ice cream, a pickle, Swiss cheese, salami, a lollipop, cherry pie, sausage, a cupcake, and watermelon — and gets a stomach ache. On Sunday he eats one nice green leaf and feels better. He's no longer a tiny caterpillar but a big fat one. He builds a cocoon, stays inside for two weeks, and finally emerges as a beautiful butterfly.",
  },
  k02: {
    title: "The Cat in the Hat",
    author: "Dr. Seuss",
    grade: "K",
    summary:
      "Sally and her brother are stuck inside on a cold, wet, rainy day with nothing to do, watched only by their pet fish in a bowl. A tall Cat in a red-and-white striped hat barges in uninvited and promises fun. The Cat balances a cake, a fish in its bowl, books, milk, a fan, a toy boat, and more on his arms and head, then crashes everything down. The Cat brings out Thing One and Thing Two from inside a big red box; they fly kites through the house, knock down Mom's new pink-and-white dress, and crash things around. The fish frantically warns that Mom is on her way home. Just in time, the Cat brings out a magical pickup machine that scoops everything up and puts the house back to perfect order. The Cat leaves with a tip of his hat. When Mom asks what they did, the kids wonder if they should tell her.",
  },
  k03: {
    title: "We're Going on a Bear Hunt",
    author: "Michael Rosen",
    grade: "K",
    summary:
      "A family — a dad, four children, and a dog — sets off to find a bear, saying they're not scared. They cross long swishy-swashy grass, splash through a deep cold river, squelch through thick oozy mud, stumble through a big dark forest, swirl through a whirling snowstorm, and tiptoe into a narrow gloomy cave. Inside the cave they meet a real bear with shiny eyes. They run back the way they came — through the cave, snow, forest, mud, river, and grass — get home, slam the front door, hide under their bedroom covers, and decide they're not going on a bear hunt again. Each obstacle has a memorable sound (swishy swashy, splash splosh, squelch squerch).",
  },
  k04: {
    title: "Goldilocks and the Three Bears",
    author: "James Marshall",
    grade: "K",
    summary:
      "A little girl named Goldilocks wanders through the woods and finds the house of three bears (Papa, Mama, and Baby Bear) who are out walking while their porridge cools. She lets herself in. She tries Papa's porridge (too hot), Mama's (too cold), and Baby's (just right) — and eats it all up. She tries Papa's chair (too hard), Mama's (too soft), and Baby's (just right) — and breaks it. She tries Papa's bed (too hard), Mama's (too soft), and Baby's (just right) — and falls asleep. The three bears come home and discover the mess: 'Someone's been eating my porridge!' / 'Someone's been sitting in my chair!' / 'Someone's been sleeping in my bed!' Goldilocks wakes up to see the three bears, screams, jumps out the window, and runs away into the forest.",
  },
  k05: {
    title: "Mother Goose's Nursery Rhymes",
    author: "Iona Opie (ed.)",
    grade: "K",
    summary:
      "A classic collection of traditional English nursery rhymes and verses passed down for centuries. Includes Humpty Dumpty (who falls off a wall and can't be put back together by all the king's horses and all the king's men), Jack and Jill (who go up a hill to fetch a pail of water and tumble down), Little Miss Muffet (who sits on a tuffet eating curds and whey and is frightened away by a spider), Hey Diddle Diddle (the cat with a fiddle, the cow that jumps over the moon, the dish that runs away with the spoon), Mary Had a Little Lamb (whose fleece was white as snow and followed her to school), Twinkle Twinkle Little Star, The Itsy Bitsy Spider (who climbs up a water spout, gets washed out by rain, and climbs again when the sun dries the rain), and Hickory Dickory Dock (a mouse runs up a clock and runs down when it strikes one).",
  },
  k06: {
    title: "The Gruffalo",
    author: "Julia Donaldson",
    grade: "K",
    summary:
      "A clever little mouse walks alone through the deep dark wood. A fox sees the mouse and invites him to lunch (planning to eat him), but the mouse says he is meeting a gruffalo — a terrible creature with terrible tusks, terrible claws, and terrible teeth in his terrible jaws, with knobbly knees and turned-out toes and a poisonous wart on the end of his nose. The fox runs away scared. The mouse next meets an owl (who invites him to tea) and a snake (who invites him to a feast), and uses the same trick on both, scaring them away. But then — surprise! — a real gruffalo appears, looking exactly as the mouse described. The mouse cleverly tells the gruffalo that the mouse himself is the scariest creature in the wood and offers to prove it. They walk back through the forest where the fox, owl, and snake all flee at the sight of the mouse (actually frightened by the gruffalo behind him). The gruffalo, now convinced the mouse is terrifying, runs off too. The mouse sits down to a quiet nut feast alone.",
  },
  k07: {
    title: "If You Give a Mouse a Cookie",
    author: "Laura Numeroff",
    grade: "K",
    summary:
      "A boy gives a small mouse a chocolate-chip cookie. The mouse asks for a glass of milk to go with it. Then a straw. Drinking the milk gives him a milk mustache, so he asks for a napkin and a mirror to check it. He sees he needs a haircut and asks for nail scissors. The hair clippings need sweeping, so he asks for a broom. He sweeps the floor, mops, and is so tired he wants a nap. He needs a story to fall asleep. After his nap he wants to draw a picture. Then he wants to sign it with a pen, then hang it on the refrigerator with tape. Looking at the fridge reminds him he's thirsty — so he asks for a glass of milk. And of course, if he gets a glass of milk, he's going to want a cookie to go with it. The story loops back to where it started.",
  },
  k08: {
    title: "Green Eggs and Ham",
    author: "Dr. Seuss",
    grade: "K",
    summary:
      "A character named Sam-I-am repeatedly offers a grumpy unnamed character a plate of green eggs and ham. The grumpy character refuses again and again, saying he does not like green eggs and ham. Sam asks him to try them in many places and ways: in a house, with a mouse, in a box, with a fox, in a car, here, there, anywhere, in a tree, on a train, in the dark, in the rain, with a goat, on a boat. The grumpy character refuses every single time, growing more annoyed. The book is told in rhyme using only about 50 different words. Finally, after Sam pesters him relentlessly, the grumpy character agrees to try the green eggs and ham — and discovers he LIKES them! He thanks Sam-I-am.",
  },
  /* ---------- Grade 1 ---------- */
  a01: {
    title: "The Tale of Peter Rabbit",
    author: "Beatrix Potter",
    grade: "1",
    summary:
      "Mrs. Rabbit tells her four bunny children — Flopsy, Mopsy, Cotton-tail, and Peter — that they may play in the field but they must NOT go into Mr. McGregor's garden, because their father had been caught and put in a pie there. The three good little bunnies go to gather blackberries. Peter, who is naughty, runs straight to the garden and squeezes under the gate. He eats lettuces, French beans, and radishes, then looks for parsley to settle his stomach. Mr. McGregor spots him and chases him with a rake. Peter loses his blue jacket and his shoes escaping. He hides in a watering can, sneezes, runs again, and finally finds the gate. He gets home tired and sick. Mrs. Rabbit puts him to bed with chamomile tea while his sisters Flopsy, Mopsy, and Cotton-tail have bread and milk and blackberries for supper.",
  },
  a02: {
    title: "Owl at Home",
    author: "Arnold Lobel",
    grade: "1",
    summary:
      "Five short, gentle stories about Owl, who lives alone in a small house. In 'The Guest,' Owl invites Winter inside to warm up, but Winter blows snow and freezes the furniture. In 'Strange Bumps,' Owl sees two strange bumps under his blanket at the foot of his bed, doesn't realize they're his own feet, and gets so worried he sleeps in his armchair downstairs. In 'Tear-Water Tea,' Owl makes a special tea by thinking of sad things (chairs with broken legs, spoons that have fallen behind the stove, books that can't be read because pages are torn) to make himself cry into the kettle. In 'Upstairs and Downstairs,' Owl runs up and down his stairs trying to be in two places at once. In 'Owl and the Moon,' Owl meets the moon at the seashore, talks to it, and worries when clouds hide it, but is delighted when the moon follows him home and shines in his bedroom window.",
  },
  a03: {
    title: "Frog and Toad Are Friends",
    author: "Arnold Lobel",
    grade: "1",
    summary:
      "Five short stories about two best friends, Frog (tall and green) and Toad (short and brown). In 'Spring,' Frog wakes Toad from winter sleep by tearing pages off the calendar to trick him about the date. In 'The Story,' Toad tries to think of a story to tell Frog when Frog is sick — he stands on his head, pours water on himself, bangs his head on the wall — and can't, until Frog gets better and tells the story himself. In 'A Lost Button,' Toad loses a white four-holed button on a walk; they find many wrong buttons (black, big, two-holed, square, thin) before Toad discovers his lost button at home on the floor, and sews all the buttons onto a jacket as a gift for Frog. In 'A Swim,' Toad refuses to come out of the water in his funny swimming suit because turtles, lizards, snakes, a dragonfly, and a field mouse are all watching; when he finally does, they all laugh. In 'The Letter,' Frog writes Toad a letter because Toad has never gotten one; Frog gives it to a snail to deliver, and they wait together for four days until it arrives.",
  },
  a04: {
    title: "Nate the Great",
    author: "Marjorie Weinman Sharmat",
    grade: "1",
    summary:
      "Nate is a young boy detective who loves pancakes and works on cases in his neighborhood. His friend Annie calls him in a panic — she has lost a picture she painted of her dog Fang. Nate puts on his detective hat, eats a stack of pancakes for energy, and gets to work. He interviews Annie's brother Harry (who has been painting his own pictures of monsters and dragons), the dog Fang (who is huge and has big teeth), and Rosamond (a strange girl with four cats named Super Hex, Plain Hex, Little Hex, and Big Hex). After studying clues, Nate realizes the picture wasn't lost — Harry painted over the back of Annie's picture by mistake, hiding the real picture underneath. Nate solves the case and goes home for more pancakes.",
  },
  a05: {
    title: "Henry and Mudge: The First Book",
    author: "Cynthia Rylant",
    grade: "1",
    summary:
      "Henry is an only child with no brothers, no sisters, and no other kids on his street. He's lonely and asks his parents for a dog. They get him a tiny puppy named Mudge with soft, droopy ears. Mudge grows fast — from seven pounds to a hundred and eighty pounds, with thick neck folds and big drooping jowls. He becomes Henry's best friend. They walk to school together, and Mudge waits at the corner curb to walk Henry home. One day Henry walks home a different way without Mudge. Mudge gets lost in the woods. Both Henry and Mudge worry and search for each other through the night. They are reunited in the morning and Henry hugs Mudge for a long time. They decide they never want to be apart again, and Henry dreams of fish and Mudge dreams of dogs.",
  },
  a06: {
    title: "The Dot",
    author: "Peter H. Reynolds",
    grade: "1",
    summary:
      "Vashti is a girl who sits in art class with a blank piece of paper, convinced she can't draw. Her teacher gently tells her to just make a mark and see where it takes her. Frustrated, Vashti jabs the paper with her pen — making one small dot. Her teacher asks her to sign it. The next week, Vashti walks into art class and sees that her teacher has framed her dot in a swirly gold frame and hung it above her desk. Vashti thinks she can make a better dot than that. She starts experimenting — making big dots, bright dots, swirly dots, red dots, blue dots, yellow dots, dots made of many small dots, and even a not-a-dot dot (an empty space inside the frame). At an art show, a little boy admires her work and says he can't draw. Vashti hands him a blank paper and tells him to just make a mark and see where it takes him — passing on what her teacher taught her.",
  },
  a07: {
    title: "Where the Wild Things Are",
    author: "Maurice Sendak",
    grade: "1",
    summary:
      "Max, a boy in a wolf costume, makes mischief at home — chasing the dog with a fork, hammering nails into the wall, hanging a stuffed animal from a clothesline. His mother calls him 'WILD THING!' and sends him to bed without his supper. In his room, a forest grows up around him, the walls become the world all around, and an ocean appears with a private boat. Max sails away through night and day and in and out of weeks for almost a year to where the wild things are. The wild things are giant monsters with terrible claws, terrible roars, terrible horns, and terrible yellow eyes. They try to scare him, but Max tames them by staring without blinking. They make him king of all wild things, and they have a wild rumpus together. Max begins to feel lonely and wants to be where someone loves him best of all. He sails back home and finds his supper still hot waiting in his room.",
  },
  a08: {
    title: "The Story about Ping",
    author: "Marjorie Flack",
    grade: "1",
    summary:
      "Ping is a small yellow duck who lives on a wise-eyed boat on the Yangtze River in China with his mother, father, two sisters, three brothers, eleven aunts, seven uncles, and forty-two cousins. Every evening at sunset, the duck family climbs up a small bridge back onto the boat, and the last duck up gets a spank from the boat's master. One evening Ping is the last duck and doesn't want to be spanked, so he hides under a bush on the river bank. The boat leaves without him. Ping has adventures down the river — he sees fishermen with cormorants (birds with metal rings around their necks so they cannot swallow the fish they catch), he is captured by a boy who slips him under a basket as dinner, and the boy's family ultimately decides to let him go free. Ping finds his family's boat again the next sunset, climbs the bridge, accepts his spank from the master, and is happy to be home with his family.",
  },
  a09: {
    title: "Corduroy",
    author: "Don Freeman",
    grade: "1",
    summary:
      "Corduroy is a small teddy bear in green overalls who sits on a shelf in the toy section of a large department store, hoping someone will take him home. A little girl named Lisa wants to buy him, but her mother says no — they don't have enough money, and besides, Corduroy is missing one of the buttons on his overall straps. That night when the store is closed, Corduroy climbs off the shelf and goes searching for his lost button. He rides an escalator up (which he thinks is a mountain), wanders through the furniture department (which he thinks is a palace), and tries to pull a button off a mattress, tipping the mattress over with a loud crash. The night watchman hears the noise, finds Corduroy, and puts him back on the toy shelf. The next morning Lisa returns with money she has saved in her piggy bank, buys Corduroy, and takes him home. She sews a new button on his overall strap and tells him he is her friend.",
  },
  a10: {
    title: "Knuffle Bunny",
    author: "Mo Willems",
    grade: "1",
    summary:
      "Trixie is a little girl who can't talk in real words yet. One morning she and her daddy go on an errand to the laundromat. Trixie brings her favorite stuffed rabbit, Knuffle Bunny. Daddy puts the laundry in the washing machine (along with Knuffle Bunny by accident, without realizing). They leave the laundromat. On the way home, Trixie realizes Knuffle Bunny is missing. She tries to tell Daddy with babbling and grunts ('Aggle flaggle klabble!'), but he doesn't understand and thinks she's just being fussy. She gets more and more upset, finally going boneless and crying. When they get home, Mommy immediately notices Knuffle Bunny is missing. The whole family rushes back to the laundromat. Daddy frantically searches through the washing machines, finally finding the soggy bunny inside one of them. Trixie speaks her first real words: 'Knuffle Bunny!!!'",
  },
  a11: {
    title: "The Ugly Duckling",
    author: "Hans Christian Andersen",
    grade: "1",
    summary:
      "A mother duck sits on her eggs. Most hatch into normal little yellow ducklings, but one egg is bigger and takes longer to hatch — out comes a large, gray, awkward duckling. The other animals on the farm — ducks, chickens, the turkey — laugh at him, peck him, and chase him away. Even his own siblings reject him. Heartbroken, the ugly duckling runs away. He spends a long, hard winter alone — nearly freezing in an icy pond, hiding from hunters and their dogs, and surviving briefly with the help of a peasant farmer who takes him in. When spring finally comes, the ugly duckling sees a flock of beautiful white swans gliding across a pond. He swims toward them, expecting them to attack him — but instead they greet him as one of their own. When he looks down at his reflection in the water, he sees that he has grown into a beautiful white swan. He realizes he was never an ugly duckling at all — he was always meant to be a swan.",
  },
  /* ---------- Grade 2 ---------- */
  b01: {
    title: "The True Story of the Three Little Pigs",
    author: "Jon Scieszka",
    grade: "2",
    summary:
      "Alexander T. Wolf tells his own version of the famous fairy tale from prison, where he is locked up. He claims the whole story has been misunderstood. He says he just had a terrible cold (with huge sneezes) and went to borrow a cup of sugar from his neighbor, the first little pig, to bake a birthday cake for his dear old granny. When the first pig didn't answer the door, the wolf says he sneezed so hard it accidentally blew down the pig's straw house — and the pig was dead inside. The wolf says it would have been a shame to waste a perfectly good ham dinner, so he ate the pig. The same thing happens at the second pig's stick house. At the third pig's brick house, the wolf is still sneezing and asking for sugar — but the third pig insults his granny, the wolf loses his temper and tries to break in, the police arrive, and the news media exaggerates the whole thing into the famous story. The wolf insists he was framed.",
  },
  b02: {
    title: "Owl Moon",
    author: "Jane Yolen",
    grade: "2",
    summary:
      "A young girl goes 'owling' for the first time, late at night in winter, with her father. The snow is bright white and the moon is full. They walk through the dark pine trees, past their farm, and into the woods. They have to be silent — owling requires no talking and no questions, the girl reminds herself. Pa makes a call by cupping his hands around his mouth and hooting ('Whoo-whoo-whoo-whoo-whoooooo'). At first no owl answers, and they walk deeper into the forest. Pa calls again. This time a great horned owl answers, then flies down silently on huge wings and lands on a branch right in front of them. Pa shines his flashlight on it. The girl and the owl look at each other for a long quiet moment in the snowy moonlight. Then the owl flies away. They walk home together, and the girl reflects that going owling needs hope and the patience to be quiet — that you don't need words or warm hands, just hope.",
  },
  b03: {
    title: "The Velveteen Rabbit",
    author: "Margery Williams",
    grade: "2",
    summary:
      "On Christmas morning, a boy receives a stuffed velveteen rabbit as a gift. At first the Rabbit is loved, but soon the boy plays with newer, fancier mechanical toys and the Rabbit sits forgotten on the nursery shelf. The wise old Skin Horse, who has lived in the nursery longest, tells the Rabbit about being 'Real' — that toys become Real when a child loves them for a very long time, until their fur is rubbed off, their joints loosen, and they get shabby. One night the boy's nanny grabs the Rabbit for him at bedtime because his favorite china dog has been lost, and from then on they become inseparable. The Rabbit is loved threadbare. The boy says 'You aren't a toy. You're REAL.' Then the boy gets very sick with scarlet fever. After he recovers, the doctor orders all his old playthings burned to prevent infection — including the Velveteen Rabbit. The Rabbit, alone in the garbage pile at the bottom of the garden, cries a real tear. From his tear grows the nursery magic Fairy, who tells him he was Real to the boy and now she will make him Real to everyone. The Rabbit transforms into a real, living rabbit and hops away to join the wild rabbits in the woods.",
  },
  b04: {
    title: "The Lighthouse Family: The Storm",
    author: "Cynthia Rylant",
    grade: "2",
    summary:
      "A lonely white cat named Pandora lives in a lighthouse on a small island and faithfully keeps the light burning each night for ships at sea. A small brown dog named Seabold is sailing alone in a small boat when a terrible storm wrecks him on the rocks below the lighthouse. Pandora rescues him, nurses him back to health with broth and warm blankets, and they slowly become friends as Seabold recovers from his broken leg. One night during another storm, they hear a tiny knock at the lighthouse door — three orphaned mice (the brother Whistler, and his two sisters Lila and the very small Tiny) have washed up on the rocks. Pandora and Seabold welcome the mice in and feed them. Together — a cat, a dog, and three little mice — they discover that they have become a family. This is the first book in the Lighthouse Family series.",
  },
  b05: {
    title: "Flat Stanley: His Original Adventure",
    author: "Jeff Brown",
    grade: "2",
    summary:
      "Stanley Lambchop is an ordinary boy until one night his giant bulletin board falls on him in his sleep. He wakes up perfectly flat — only half an inch thick, but otherwise the same. At first being flat is fun: he can slide under doors, fit into envelopes, and his mother folds him up and carries him in her purse. His parents save money on a trip by mailing Stanley in an envelope to visit a friend in California. When his mother loses her diamond ring down a sidewalk grate, Stanley is lowered down on a string to retrieve it. He helps the police catch art thieves at a museum by pretending to be a painting on the wall — when the thieves arrive at night, he jumps out and scares them, and they're arrested. But Stanley starts feeling sad and self-conscious; kids start calling him names. His younger brother Arthur has an idea: he gets a bicycle pump, pokes the pump nozzle into Stanley's mouth, and pumps him back up to a normal three-dimensional shape. The two brothers high-five and go to bed happy.",
  },
  b06: {
    title: "Mercy Watson to the Rescue",
    author: "Kate DiCamillo",
    grade: "2",
    summary:
      "Mercy Watson is a pig who lives with Mr. and Mrs. Watson, who treat her like a daughter. Mercy LOVES buttered toast — it's her favorite food in the world. One night Mercy can't sleep, so she sneaks into the Watsons' bed in the middle of the night for comfort. The bed is too small and Mercy is too big — it slowly cracks and begins to fall through the floor. Mr. and Mrs. Watson wake up in a panic and shout for help. Mercy, sensing an emergency, climbs off the bed and leaves the room — but instead of getting help, she goes to the kitchen because she suddenly smells buttered toast in the neighbor's house. She runs through the neighborhood searching for the toast smell, terrifying the elderly Lincoln sisters next door (Eugenia and Baby), who think she's a burglar. Eugenia calls the fire department, who come and rescue the Watsons from the collapsing bed (and Mercy from the Lincolns' kitchen). Everyone ends up eating buttered toast together at the Watsons' kitchen table — including the firefighters and the Lincoln sisters. The book ends with a recipe for buttered toast.",
  },
  b07: {
    title: "Fantastic Mr. Fox",
    author: "Roald Dahl",
    grade: "2",
    summary:
      "Mr. Fox lives with his wife and four small fox children in a cozy hole under a tree on a hill. Every night he sneaks down to one of three farms — owned by three nasty farmers named Boggis (fat, eats three boiled chickens with dumplings every day), Bunce (short, eats doughnuts with goose-liver paste), and Bean (skinny, drinks gallons of cider) — and steals food. The farmers get fed up and decide to stake out his hole with shotguns. They shoot off the end of his tail, but he escapes underground. The farmers try to dig him out with shovels, then with bulldozers and excavators, destroying the entire hill. The Fox family starves underground for days. Then Mr. Fox has a brilliant plan: instead of digging up, dig sideways. He and his children tunnel into Boggis's chicken house, Bunce's storehouse of geese and ducks, and Bean's secret cider cellar. They steal a feast. Mr. Fox invites the other underground animals (Badger, Mole, Rabbit, and Weasel) and their families to a grand banquet underground. The three farmers are left waiting outside the hole in the rain forever, never realizing the foxes are now living comfortably below them.",
  },
  b08: {
    title: "Geeger the Robot Goes to School",
    author: "Jarrett Lerner",
    grade: "2",
    summary:
      "Geeger is a small friendly robot who eats food scraps — especially banana peels, his favorite. He lives with the Mendez family. Today is his very first day of school. Geeger is nervous — what if the other kids don't like him because he's a robot? He gets ready, eats his breakfast (some peels), and rides the bus. At school he meets his new teacher Ms. Bork and is shown his desk. The other kids stare at his shiny metal body, and he feels uncomfortable. At lunch, Geeger sits alone — until a girl named Tillie comes over with a banana, peels it, eats the fruit, and offers him the peel. They become friends. The book is the first in an early-reader series about Geeger's school adventures.",
  },
  b09: {
    title: "The Magic Faraway Tree",
    author: "Enid Blyton",
    grade: "2",
    summary:
      "Three siblings — Joe, Beth, and Frannie — move to the countryside next to a magical enchanted forest. At the top of a giant Faraway Tree that grows in the forest, a different magical land arrives every few days through a hole in the clouds — but the land moves on after a while, so visitors have to climb back down before it leaves or they'll be stuck forever. The children meet the tree's strange residents: Moon-Face (a round-faced creature who lives at the top with a slippery-slip slide that goes all the way down inside the trunk), Silky the Fairy (who has long golden hair), the Saucepan Man (deaf, covered in pots and pans that clang as he walks), and Mr. Watzisname (who is always asleep). They climb up to visit lands like the Land of Take-What-You-Want, the Land of Birthdays, the Rocking Land (where everything rocks back and forth), the Land of Topsy-Turvy, and the Land of Goodies. Each visit is a separate adventure where they sometimes barely escape back down the tree in time before the land moves on with them inside.",
  },
};

// 12 questions in the pool. Client picks 5 per attempt (80% pass = 4/5).
// Bigger pool gives section 1d.1's question-rotation logic room to draw
// fully fresh questions on attempt 2 with no overlap.
const POOL_SIZE = 12;

const QuizSchema = z.object({
  questions: z
    .array(
      z.object({
        q: z
          .string()
          .describe(
            "The question, in simple words a 5-year-old can read or hear read aloud."
          ),
        options: z
          .array(z.string())
          .length(4)
          .describe("Exactly 4 answer choices, all plausible to a child."),
        answer: z
          .number()
          .int()
          .min(0)
          .max(3)
          .describe("Index (0-3) of the correct option."),
      })
    )
    .length(POOL_SIZE),
});

// QC reviewer schema — a structured rubric for each question.
const QCSchema = z.object({
  reviews: z.array(
    z.object({
      questionIndex: z.number().int().min(0),
      accuracy: z
        .number()
        .int()
        .min(0)
        .max(10)
        .describe(
          "0 = clearly wrong or references something not in the book; " +
            "10 = unambiguously answerable from the canonical summary."
        ),
      issues: z
        .array(z.string())
        .optional()
        .describe("Specific problems found, if any."),
    })
  ),
});

// Bump the schema version whenever we change shape — old cached entries are
// then ignored automatically (cache key includes the version).
// v3: pool size 8 → 12 + 27 new books backfilled
// v4: cache keyed by (book, studentGrade) — quizzes are grade-leveled to
//     the reader, not the book. A G2 reading a K book gets G2-level questions.
// v5: switched generation model Haiku 4.5 → Opus 4.5 and added a separate
//     Opus 4.5 QC reviewer pass that drops questions with accuracy < 7/10.
const SCHEMA_VERSION = 5;

// Quiz model + QC reviewer model. Opus 4.5 for both — generation needs the
// stronger model for accuracy on lesser-known books; QC needs it to reliably
// flag the rare hallucination that slips through.
const GEN_MODEL = "claude-opus-4-5";
const QC_MODEL  = "claude-opus-4-5";

// QC accuracy threshold. Anything below this gets dropped from the pool.
const QC_MIN_ACCURACY = 7;
// If QC drops so many questions that fewer than this remain, the pool is
// unusable and we fail rather than serving a tiny quiz.
const MIN_USABLE_POOL = 8;

// How AI should calibrate question difficulty for each student grade.
// The book itself stays the same — only the questions change to match
// the reader's level.
const GRADE_GUIDANCE = {
  K:
    "Test LITERAL RECALL — what happened, who appeared, what they ate, " +
    "basic colors and counts. Use very simple, concrete words a five-year-old " +
    "would know. AVOID inference, theme, or abstract concepts.",
  "1":
    "Test recall plus simple SEQUENCE (what happened first, next, last) " +
    "and BASIC CAUSE-AND-EFFECT (why was the character sad? what did the " +
    "character do next?). Use simple-to-moderate vocabulary.",
  "2":
    "Test recall, INFERENCE (what the character was feeling, what they " +
    "might do next, why they made a choice), sequence, cause-and-effect, " +
    "and the LESSON OR THEME of the story. Multi-step thinking is " +
    "appropriate. Use full grade-appropriate vocabulary.",
  "3":
    "Test DEEPER INFERENCE, theme, character motivation, prediction, and " +
    "author's purpose. Vocabulary can be richer. Some questions can ask " +
    "the student to synthesize information across the whole story.",
  "4":
    "Same as Grade 3 but with more complex inference and analytical " +
    "thinking. Compare/contrast questions are appropriate.",
  "5":
    "Same as Grade 4 with richer vocabulary, more sophisticated inference, " +
    "and analysis of literary technique where relevant.",
};

// QC reviewer: takes a freshly-generated pool of questions and scores each
// for accuracy against the book's canonical summary. Drops questions with
// accuracy below QC_MIN_ACCURACY. Returns { questions: [keepers], dropped: [{idx, accuracy, issues}] }.
async function qcAndFilter(book, studentGrade, questions) {
  const letters = ["A", "B", "C", "D"];
  const formatted = questions
    .map(
      (q, i) =>
        `${i}. ${q.q}\n   A) ${q.options[0]}\n   B) ${q.options[1]}\n   ` +
        `C) ${q.options[2]}\n   D) ${q.options[3]}\n   ` +
        `[marked correct: ${letters[q.answer]}]`
    )
    .join("\n\n");

  let reviews;
  try {
    const { object } = await generateObject({
      model: anthropic(QC_MODEL),
      schema: QCSchema,
      system:
        "You are a strict reading-comprehension QC reviewer for an " +
        "elementary-school reading app. Your job: catch hallucinations and " +
        "inaccuracies in AI-generated quiz questions.\n\n" +
        "For each question, verify it against the canonical plot summary. " +
        "Score 0-10:\n" +
        "  10 = unambiguously answerable from the summary; correct answer is " +
        "clearly correct; distractors are plausible-but-wrong\n" +
        "   7 = workable but minor wording issue (still ship it)\n" +
        "   4 = answer is questionable, or 2+ options could be defended as correct\n" +
        "   0 = fabricated detail not in the book, wrong answer, or " +
        "unanswerable from the summary\n\n" +
        "Be skeptical. If a question references a character name, number, " +
        "color, action, or event you can't find in the summary, score it LOW. " +
        "Don't pad scores to be nice — accuracy matters more than volume.",
      prompt:
        `Book: "${book.title}" by ${book.author}\n` +
        `Grade level (calibration target): ${studentGrade}\n\n` +
        `Canonical plot summary (the ONLY source of truth):\n${book.summary}\n\n` +
        `Questions to review:\n\n${formatted}\n\n` +
        `For EVERY question (indexes 0 through ${questions.length - 1}), ` +
        `return an entry with that index, an accuracy score, and any specific ` +
        `issues you found. Do not skip any.`,
    });
    reviews = object.reviews || [];
  } catch (err) {
    // QC call failed — degrade gracefully by accepting all generated questions.
    // Better to serve a (possibly imperfect) quiz than to block on QC failure.
    console.warn("[quiz_qc_failed]", String(err?.message || err));
    return { questions, dropped: [] };
  }

  const reviewByIdx = new Map();
  for (const r of reviews) reviewByIdx.set(r.questionIndex, r);

  const survivors = [];
  const dropped = [];
  for (let i = 0; i < questions.length; i++) {
    const r = reviewByIdx.get(i);
    // If QC didn't review a question (model omission), keep it but log.
    if (!r) {
      survivors.push(questions[i]);
      continue;
    }
    if (r.accuracy >= QC_MIN_ACCURACY) {
      survivors.push(questions[i]);
    } else {
      dropped.push({
        idx: i,
        accuracy: r.accuracy,
        issues: r.issues || [],
        question: questions[i].q,
      });
    }
  }

  if (dropped.length > 0) {
    console.log(
      `[quiz_qc] ${book.title} grade=${studentGrade}: kept ${survivors.length}/${questions.length}`,
      dropped.map((d) => `Q${d.idx}(${d.accuracy})`).join(", ")
    );
  }

  return { questions: survivors, dropped };
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  const secret = process.env.AUTH_SECRET;
  const cookies = parseCookies(req.headers.cookie);
  const session = await verifySession(cookies.rs_session, secret);
  if (!session) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: "unauthenticated" }));
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const bookId = url.searchParams.get("bookId");

  if (!bookId || !QUIZ_BOOKS[bookId]) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ available: false, bookId }));
  }

  // Resolve the student's working grade. For now: derive from email.
  // Eventually this will come from an explicit per-student field set
  // by a teacher/admin (TODO 1c Phase D).
  const studentGrade = normalizeGrade(
    guessGradeFromEmail(session.email) || "K"
  );

  // Cache key: (book, student grade). Different grades get different
  // question pools because difficulty is calibrated to the reader.
  const cacheKey = `v${SCHEMA_VERSION}:${bookId}:${studentGrade}`;
  const cached = await getCachedQuiz(cacheKey);
  if (
    cached &&
    Array.isArray(cached.questions) &&
    cached.questions.length >= MIN_USABLE_POOL
  ) {
    res.statusCode = 200;
    res.setHeader("Cache-Control", "private, max-age=86400");
    return res.end(
      JSON.stringify({
        available: true,
        bookId,
        poolSize: cached.questions.length,
        studentGrade,
        cached: true,
        ...cached,
      })
    );
  }

  const book = QUIZ_BOOKS[bookId];
  const guidance = GRADE_GUIDANCE[studentGrade] || GRADE_GUIDANCE.K;

  try {
    // ---------- Generation pass (Opus 4.5) ----------
    const { object } = await generateObject({
      model: anthropic(GEN_MODEL),
      schema: QuizSchema,
      system:
        `You are an early-elementary reading specialist designing reading-` +
        `comprehension questions for a GRADE ${studentGrade} reader.\n\n` +
        `DIFFICULTY CALIBRATION for Grade ${studentGrade}:\n${guidance}\n\n` +
        `Tone: warm and concrete. Each question has EXACTLY 4 options, ONE ` +
        `of which is clearly correct. The other three should be plausible-` +
        `but-wrong things a kid who skimmed might pick. Vary which index ` +
        `(0,1,2,3) is correct across all questions — don't bunch the ` +
        `correct answers at the same position.\n\n` +
        `CRITICAL: Only ask about details that are explicitly in the plot ` +
        `summary provided. Do NOT invent characters, events, items, or ` +
        `numbers. If you can't verify a detail in the summary, do NOT use ` +
        `it as a question or distractor.`,
      prompt:
        `Write ${POOL_SIZE} reading-comprehension questions for the book ` +
        `"${book.title}" by ${book.author}.\n\n` +
        `The student is in Grade ${studentGrade}. The book is recommended ` +
        `for Grade ${book.grade} readers. If the student is OLDER than the ` +
        `book's level, still calibrate questions to the STUDENT's grade — ` +
        `don't dumb them down just because the book is short. If the student ` +
        `is YOUNGER than the book, keep questions simple even though the ` +
        `book is more advanced.\n\n` +
        `Plot summary (the source of truth — do NOT quote it verbatim, ` +
        `but every question must be answerable from these details):\n${book.summary}\n\n` +
        `The questions should cover DIFFERENT aspects of the book so that any random ` +
        `subset of 5 still tests broad comprehension.\n\n` +
        `Hard rules:\n` +
        `- Avoid trick questions.\n` +
        `- Keep each question under 18 words.\n` +
        `- Keep each option under 8 words.\n` +
        `- No two questions should be near-duplicates.\n` +
        `- Every fact you assert must appear in the plot summary above.`,
    });

    // ---------- QC reviewer pass (Opus 4.5) ----------
    // Independent second opinion: score each generated question for
    // accuracy against the canonical summary. Drop low-scoring questions.
    const reviewedPool = await qcAndFilter(book, studentGrade, object.questions);

    if (reviewedPool.questions.length < MIN_USABLE_POOL) {
      // Too many questions failed QC to produce a usable quiz.
      console.error(
        "[quiz_qc_too_strict]",
        bookId,
        studentGrade,
        "survivors:",
        reviewedPool.questions.length,
        "of",
        object.questions.length
      );
      res.statusCode = 500;
      return res.end(
        JSON.stringify({
          error: "qc_no_viable_questions",
          message:
            "The quiz generator produced too many low-quality questions for this book. Try again — the next run will regenerate from scratch.",
        })
      );
    }

    const payload = {
      questions: reviewedPool.questions,
      qc: {
        generated: object.questions.length,
        kept: reviewedPool.questions.length,
        dropped: reviewedPool.dropped,
      },
    };
    await setCachedQuiz(cacheKey, payload);

    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        available: true,
        bookId,
        poolSize: reviewedPool.questions.length,
        studentGrade,
        cached: false,
        ...payload,
      })
    );
  } catch (err) {
    console.error("quiz_generation_failed", err);
    res.statusCode = 500;
    return res.end(
      JSON.stringify({
        error: "quiz_generation_failed",
        message:
          "Couldn't build the quiz right now. Check ANTHROPIC_API_KEY is set on the Vercel project. Try again in a minute.",
      })
    );
  }
}
